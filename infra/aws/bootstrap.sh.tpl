#!/bin/bash
# Render the named placeholders from CloudFormation; never enable shell tracing.
set -euo pipefail
umask 027
trap 'printf "DriveMate bootstrap failed at line %s\n" "$LINENO" >&2' ERR
export DEBIAN_FRONTEND=noninteractive

apt-get -o DPkg::Lock::Timeout=120 update
apt-get -o DPkg::Lock::Timeout=120 install -y --no-install-recommends \
  openjdk-17-jre-headless python3 python3-venv python3-boto3 python3-psycopg2 nginx curl ca-certificates unzip gnupg logrotate
systemctl stop nginx.service
getent group drivemate-data >/dev/null || groupadd --system drivemate-data
getent group drivemate-config >/dev/null || groupadd --system drivemate-config
getent group drivemate >/dev/null || groupadd --system drivemate
id drivemate >/dev/null 2>&1 || useradd --system --home-dir /opt/drivemate --shell /usr/sbin/nologin --gid drivemate --groups drivemate-data,drivemate-config drivemate
id drivemate-worker >/dev/null 2>&1 || useradd --system --home-dir /opt/drivemate --shell /usr/sbin/nologin --gid drivemate-data drivemate-worker
install -d -m 0755 /opt/drivemate
install -d -m 0700 /var/lib/drivemate-bootstrap
install -d -o root -g drivemate-config -m 0750 /etc/drivemate
install -d -o drivemate -g drivemate-data -m 0750 /var/log/drivemate
touch /var/log/drivemate/api.log /var/log/drivemate/cycle.log
chown drivemate:drivemate-data /var/log/drivemate/api.log
chown root:drivemate-data /var/log/drivemate/cycle.log
chmod 0640 /var/log/drivemate/api.log /var/log/drivemate/cycle.log
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /etc/drivemate/rds-global-bundle.pem
chmod 0644 /etc/drivemate/rds-global-bundle.pem

# Verify the official CloudWatch package before installing it. The pinned fingerprint
# comes from the AWS CloudWatch package-signature verification documentation.
install -d -m 0700 /var/lib/drivemate-bootstrap/gpg
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 180 \
  https://amazoncloudwatch-agent.s3.amazonaws.com/assets/amazon-cloudwatch-agent.gpg \
  -o /var/lib/drivemate-bootstrap/amazon-cloudwatch-agent.gpg
for filename in amazon-cloudwatch-agent.deb amazon-cloudwatch-agent.deb.sig; do
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 180 \
      "https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/amd64/latest/$filename" \
      -o "/var/lib/drivemate-bootstrap/$filename"
done
gpg --batch --homedir /var/lib/drivemate-bootstrap/gpg --import /var/lib/drivemate-bootstrap/amazon-cloudwatch-agent.gpg
agent_fingerprint=$(gpg --batch --homedir /var/lib/drivemate-bootstrap/gpg --with-colons --fingerprint | awk -F: '$1 == "fpr" { print $10; exit }')
test "$agent_fingerprint" = 937616F3450B7D806CBD9725D58167303B789C72
gpg --batch --homedir /var/lib/drivemate-bootstrap/gpg --verify \
  /var/lib/drivemate-bootstrap/amazon-cloudwatch-agent.deb.sig /var/lib/drivemate-bootstrap/amazon-cloudwatch-agent.deb
dpkg -i /var/lib/drivemate-bootstrap/amazon-cloudwatch-agent.deb

# The instance profile is the only source of AWS credentials.
python3 - <<'PY'
import hashlib
import json
import os
from pathlib import Path
import re
import secrets as secure_random
import stat
import sys
import zipfile

import boto3
import psycopg2
from psycopg2 import sql
from botocore.config import Config
from botocore.exceptions import ClientError

REGION = "@@REGION@@"
BUCKET = "@@BUCKET@@"
RELEASE_KEY = "@@RELEASE_KEY@@"
RELEASE_SHA256 = "@@RELEASE_SHA256@@"
DB_HOST = "@@DB_HOST@@"
DB_SECRET_ARN = "@@DB_SECRET_ARN@@"
APP_SECRET_ARN = "@@APP_SECRET_ARN@@"
QUEUE_URL = "@@QUEUE_URL@@"
ROOT = Path("/opt/drivemate")

def write_env(path, values):
    rows = []
    for key, value in values.items():
        value = str(value)
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key) or any(c in value for c in "\r\n\x00"):
            raise ValueError("Unsafe environment value")
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        rows.append(key + '="' + escaped + '"')
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        output.write("\n".join(rows) + "\n")
    os.chmod(path, 0o600)

def deploy():
    if not re.fullmatch(r"[a-fA-F0-9]{64}", RELEASE_SHA256):
        raise ValueError("Release checksum is required")
    if not re.fullmatch(r"[A-Za-z0-9.-]+", DB_HOST):
        raise ValueError("Invalid database endpoint")
    config = Config(retries={"total_max_attempts": 5, "mode": "standard"}, connect_timeout=10, read_timeout=60)
    session = boto3.Session(region_name=REGION)
    s3 = session.client("s3", config=config)
    secrets = session.client("secretsmanager", config=config)
    archive = Path("/var/lib/drivemate-bootstrap/release.zip")
    s3.download_file(BUCKET, RELEASE_KEY, str(archive))
    with archive.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual.lower() != RELEASE_SHA256.lower():
        raise ValueError("Release checksum mismatch")
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        if len(entries) > 50000 or sum(entry.file_size for entry in entries) > 2 * 1024**3:
            raise ValueError("Release archive exceeds size limit")
        for entry in entries:
            path = Path(entry.filename)
            if path.is_absolute() or ".." in path.parts or "\\" in entry.filename:
                raise ValueError("Unsafe release member")
            if stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError("Release symlinks are not accepted")
            if any(part == ".git" or part.startswith(".env") for part in path.parts):
                raise ValueError("Private configuration must not be packaged")
            target = (ROOT / path).resolve()
            if not target.is_relative_to(ROOT):
                raise ValueError("Release path escapes application directory")
        bundle.extractall(ROOT)
    required = [
        "backend-spring/target/drivemate-api-0.2.0.jar", "backend/requirements-ml.txt",
        "backend/scripts/onbid_worker.py", "infra/aws/cycle_worker.py", "infra/aws/requirements-aws.txt",
        "infra/aws/refresh_secrets.py",
        "backend/requirements-rag.txt", "backend/scripts/document_rag.py",
        "dist/index.html", "model/model_bundle.joblib", "backend/data/onbid/pipeline/latest.json",
    ]
    if any(not (ROOT / filename).is_file() for filename in required):
        raise ValueError("Release is incomplete")
    database = json.loads(secrets.get_secret_value(SecretId=DB_SECRET_ARN)["SecretString"])
    application = json.loads(secrets.get_secret_value(SecretId=APP_SECRET_ARN)["SecretString"])
    if not database.get("username") or not database.get("password"):
        raise ValueError("Database secret is incomplete")
    if not application.get("OPENAI_API_KEY") or not application.get("ONBID_SERVICE_KEY") or not application.get("DRIVEMATE_DB_PASSWORD"):
        raise ValueError("Application secret is incomplete")
    # Only bootstrap uses the RDS master credential; runtime uses an application role.
    connection = psycopg2.connect(host=DB_HOST, dbname="drivemate", user=database["username"],
        password=database["password"], sslmode="verify-full", sslrootcert="/etc/drivemate/rds-global-bundle.pem", connect_timeout=15)
    try:
        with connection:
            with connection.cursor() as cursor:
                cursor.execute("CREATE EXTENSION IF NOT EXISTS vector")
                cursor.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", ("drivemate_app",))
                action = "ALTER ROLE" if cursor.fetchone() else "CREATE ROLE"
                cursor.execute(sql.SQL(action + " {} LOGIN PASSWORD %s").format(sql.Identifier("drivemate_app")),
                    (application["DRIVEMATE_DB_PASSWORD"],))
                # PostgreSQL 16+ does not automatically give CREATEROLE users SET
                # membership in roles they create; another role's schema owner needs it.
                cursor.execute("SELECT pg_has_role(current_user, %s, 'SET')", ("drivemate_app",))
                if not cursor.fetchone()[0]:
                    cursor.execute(sql.SQL("GRANT {} TO {} WITH SET TRUE").format(
                        sql.Identifier("drivemate_app"), sql.Identifier(database["username"])))
                cursor.execute("GRANT CONNECT ON DATABASE drivemate TO drivemate_app")
                cursor.execute("GRANT USAGE, CREATE ON SCHEMA public TO drivemate_app")
                cursor.execute("CREATE SCHEMA IF NOT EXISTS drivemate_rag AUTHORIZATION drivemate_app")
    finally:
        connection.close()
    with (ROOT / "model/model_bundle.joblib").open("rb") as stream:
        model_sha = hashlib.file_digest(stream, "sha256").hexdigest()
    app = {
        "SERVER_ADDRESS": "127.0.0.1", "SERVER_PORT": "18085",
        "SERVER_FORWARD_HEADERS_STRATEGY": "framework",
        "LOGGING_FILE_NAME": "/var/log/drivemate/api.log",
        "LOGGING_LOGBACK_ROLLINGPOLICY_MAX_FILE_SIZE": "10MB",
        "LOGGING_LOGBACK_ROLLINGPOLICY_MAX_HISTORY": "7",
        "LOGGING_LOGBACK_ROLLINGPOLICY_TOTAL_SIZE_CAP": "100MB",
        "SPRING_DATASOURCE_URL": "jdbc:postgresql://" + DB_HOST + ":5432/drivemate?sslmode=verify-full&sslrootcert=/etc/drivemate/rds-global-bundle.pem",
        "SPRING_DATASOURCE_USERNAME": "drivemate_app", "SPRING_DATASOURCE_PASSWORD": application["DRIVEMATE_DB_PASSWORD"],
        "DRIVEMATE_PROVIDER_MODE": "mock", "DRIVEMATE_ALLOW_LLM": "true", "DRIVEMATE_LLM_DAILY_LIMIT": "20",
        "DRIVEMATE_PYTHON": "/opt/drivemate/venv/bin/python",
        "DRIVEMATE_ML_WORKER": "/opt/drivemate/backend/scripts/onbid_worker.py",
        "DRIVEMATE_MODEL_BUNDLE": "/opt/drivemate/model/model_bundle.joblib",
        "DRIVEMATE_MODEL_SHA256": model_sha,
        "DRIVEMATE_PREDICTION_TIMEOUT_SECONDS": "115",
        "DRIVEMATE_ANALYTICS_REPORT": "/opt/drivemate/backend/data/onbid/pipeline/latest.json",
        "DRIVEMATE_RAG_WORKER": "/opt/drivemate/backend/scripts/document_rag.py",
        "DRIVEMATE_RAG_COLLECTION": "/opt/drivemate/backend/data/rag/active_collection.json",
        "DRIVEMATE_KNOWLEDGE_ALLOWED_EMAILS": application.get("DRIVEMATE_KNOWLEDGE_ALLOWED_EMAILS", ""),
        "DRIVEMATE_BOOTSTRAP_TOKEN": secure_random.token_urlsafe(40),
        "OPENAI_API_KEY": application["OPENAI_API_KEY"],
        "OPENAI_MODEL": application.get("OPENAI_MODEL", "gpt-6-astra"),
        "DRIVEMATE_PG_HOST": DB_HOST, "DRIVEMATE_PG_DATABASE": "drivemate",
        "DRIVEMATE_PG_USER": "drivemate_app", "DRIVEMATE_PG_PASSWORD": application["DRIVEMATE_DB_PASSWORD"],
        "DRIVEMATE_PG_SSLROOTCERT": "/etc/drivemate/rds-global-bundle.pem",
    }
    if application.get("DRIVEMATE_RAG_INGEST_APPROVED") == "true":
        rag_root = ROOT / "backend/data/rag"
        manifest = json.loads((rag_root / "local_collection.json").read_text())
        prepared = (rag_root / manifest["index_relative_path"]).resolve()
        if not prepared.is_relative_to(rag_root / "collections") or not prepared.is_file() or prepared.suffix != ".json":
            raise ValueError("Prepared document collection is invalid")
        app["DRIVEMATE_RAG_PREPARED_INDEX"] = str(prepared)
    worker = {
        "AWS_REGION": REGION, "AWS_DEFAULT_REGION": REGION,
        "DRIVEMATE_CYCLE_QUEUE_URL": QUEUE_URL, "DRIVEMATE_DATA_BUCKET": BUCKET,
        "DRIVEMATE_CYCLE_OUTPUT_ROOT": "/opt/drivemate/backend/data/onbid/pipeline",
        "DRIVEMATE_REPO_ROOT": "/opt/drivemate",
        "ONBID_SERVICE_KEY": application["ONBID_SERVICE_KEY"],
        "OMP_NUM_THREADS": "2", "OPENBLAS_NUM_THREADS": "2", "MKL_NUM_THREADS": "2", "PYTHONUNBUFFERED": "1",
    }
    write_env("/etc/drivemate/app.env", app)
    write_env("/etc/drivemate/worker.env", worker)
    approval = Path("/etc/drivemate/rag-ingest-approved")
    if application.get("DRIVEMATE_RAG_INGEST_APPROVED") == "true":
        approval.touch(mode=0o600)
    else:
        approval.unlink(missing_ok=True)
    Path("/etc/drivemate/secret-refresh.json").write_text(json.dumps({"region": REGION, "app_secret_arn": APP_SECRET_ARN}))
    os.chmod("/etc/drivemate/secret-refresh.json", 0o600)
    (ROOT / "release.json").write_text(json.dumps({"release_sha256": actual, "model_sha256": model_sha}) + "\n")
    print("Release checksum verified; credentials written to root-only environment files.")

def main():
    try:
        deploy()
    except ClientError as error:
        print("Bootstrap AWS request failed: " + error.response.get("Error", {}).get("Code", "AWS_ERROR"), file=sys.stderr)
        return 1
    except Exception as error:
        print("Bootstrap configuration failed: " + type(error).__name__, file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
PY

python3 -m venv /opt/drivemate/venv
/opt/drivemate/venv/bin/pip install --no-cache-dir --disable-pip-version-check \
  -r /opt/drivemate/backend/requirements-ml.txt -r /opt/drivemate/infra/aws/requirements-aws.txt \
  -r /opt/drivemate/backend/requirements-rag.txt
/opt/drivemate/venv/bin/pip check
chown -R root:root /opt/drivemate
find /opt/drivemate -type d -exec chmod 0755 {} +
find /opt/drivemate -type f -exec chmod a+r,go-w {} +
find /opt/drivemate/dist -type d -exec chmod 0755 {} +
find /opt/drivemate/dist -type f -exec chmod 0644 {} +
install -d -o drivemate -g drivemate-data -m 0750 /opt/drivemate/data
install -d -o drivemate -g drivemate-data -m 0750 /opt/drivemate/backend/data/rag
chown -R drivemate-worker:drivemate-data /opt/drivemate/backend/data/onbid
find /opt/drivemate/backend/data/onbid -type d -exec chmod 2750 {} +
find /opt/drivemate/backend/data/onbid -type f -exec chmod 0640 {} +
chown -R root:drivemate-data /opt/drivemate/model
chmod 0750 /opt/drivemate/model
chmod 0640 /opt/drivemate/model/model_bundle.joblib
chown root:drivemate-config /etc/drivemate/app.env /etc/drivemate/worker.env
chmod 0600 /etc/drivemate/app.env /etc/drivemate/worker.env

cat > /etc/systemd/system/drivemate-api.service <<'UNIT'
[Unit]
Description=DriveMate Spring API
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=drivemate
Group=drivemate
SupplementaryGroups=drivemate-data
WorkingDirectory=/opt/drivemate
EnvironmentFile=/etc/drivemate/app.env
ExecStart=/usr/bin/java -Xms128m -Xmx768m -jar /opt/drivemate/backend-spring/target/drivemate-api-0.2.0.jar
Restart=on-failure
RestartSec=10
TimeoutStopSec=30
KillMode=control-group
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/opt/drivemate/data /var/log/drivemate
UMask=0027
MemoryMax=1800M
TasksMax=256
LimitNOFILE=8192

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/drivemate-cycle.service <<'UNIT'
[Unit]
Description=DriveMate SQS data and evaluation worker
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=drivemate-worker
Group=drivemate-data
WorkingDirectory=/opt/drivemate
EnvironmentFile=/etc/drivemate/worker.env
ExecStart=/opt/drivemate/venv/bin/python /opt/drivemate/infra/aws/cycle_worker.py
StandardOutput=append:/var/log/drivemate/cycle.log
StandardError=append:/var/log/drivemate/cycle.log
Restart=on-failure
RestartSec=15
TimeoutStopSec=60
KillMode=control-group
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/opt/drivemate/backend/data/onbid/pipeline
UMask=0027
MemoryMax=1600M
CPUQuota=100%
TasksMax=128

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/drivemate-secrets.service <<'UNIT'
[Unit]
Description=Refresh DriveMate application API keys
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=root
ExecStart=/opt/drivemate/venv/bin/python /opt/drivemate/infra/aws/refresh_secrets.py
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/etc/drivemate
UNIT

cat > /etc/systemd/system/drivemate-secrets.timer <<'UNIT'
[Unit]
Description=Check for DriveMate API key rotation

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
RandomizedDelaySec=30s
Unit=drivemate-secrets.service

[Install]
WantedBy=timers.target
UNIT

cat > /etc/systemd/system/drivemate-rag-index.service <<'UNIT'
[Unit]
Description=Build versioned DriveMate document evidence index
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=drivemate
Group=drivemate
SupplementaryGroups=drivemate-data
WorkingDirectory=/opt/drivemate
EnvironmentFile=/etc/drivemate/app.env
ExecStart=/opt/drivemate/venv/bin/python /opt/drivemate/backend/scripts/document_rag.py build --backend pgvector --prepared-index $DRIVEMATE_RAG_PREPARED_INDEX --output-dir /opt/drivemate/backend/data/rag
TimeoutStartSec=900
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/opt/drivemate/backend/data/rag
UMask=0027
MemoryMax=1024M
UNIT

cat > /etc/logrotate.d/drivemate-cycle <<'LOGROTATE'
/var/log/drivemate/cycle.log {
    daily
    maxsize 20M
    rotate 7
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
    su root root
}
LOGROTATE

# Only these application files are shipped. In particular, request bodies,
# authorization headers, query strings, environment files and raw documents are not.
# Log-group retention is managed by CloudFormation; omit agent metrics entirely.
cat > /etc/drivemate/cloudwatch-agent.json <<'JSON'
{
  "agent": {"region": "@@REGION@@", "run_as_user": "root"},
  "logs": {
    "force_flush_interval": 5,
    "logs_collected": {"files": {"collect_list": [
      {"file_path": "/var/log/drivemate/api.log", "log_group_name": "@@LOG_GROUP@@", "log_stream_name": "{instance_id}/api"},
      {"file_path": "/var/log/drivemate/cycle.log", "log_group_name": "@@LOG_GROUP@@", "log_stream_name": "{instance_id}/cycle"},
      {"file_path": "/var/log/nginx/drivemate-access.log", "log_group_name": "@@LOG_GROUP@@", "log_stream_name": "{instance_id}/nginx-access"}
    ]}}
  }
}
JSON
chmod 0640 /etc/drivemate/cloudwatch-agent.json

cat > /etc/nginx/conf.d/drivemate-logging.conf <<'NGINX'
log_format drivemate_safe '$remote_addr [$time_local] "$request_method $uri $server_protocol" $status $body_bytes_sent';
NGINX
cat > /etc/nginx/sites-available/drivemate <<'NGINX'
server {
    listen 80 default_server;
    server_name _;
    root /opt/drivemate/dist;
    index index.html;
    server_tokens off;
    client_max_body_size 6m;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    access_log /var/log/nginx/drivemate-access.log drivemate_safe;
    error_log /var/log/nginx/drivemate-error.log warn;

    location /api/v1/ {
        proxy_pass http://127.0.0.1:18085;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Connection "";
        proxy_connect_timeout 5s;
        proxy_read_timeout 125s;
        proxy_send_timeout 125s;
        proxy_buffering off;
    }
    location ~ /\. {
        deny all;
    }
    location / {
        try_files $uri $uri/ /index.html;
    }
}
NGINX
# Only replace the default site on this newly provisioned dedicated instance.
ln -sfn /etc/nginx/sites-available/drivemate /etc/nginx/sites-enabled/default
nginx -t
systemctl daemon-reload
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 -s -c file:/etc/drivemate/cloudwatch-agent.json
systemctl enable amazon-cloudwatch-agent.service
systemctl is-active --quiet amazon-cloudwatch-agent.service
if test -f /etc/drivemate/rag-ingest-approved; then
    systemctl start drivemate-rag-index.service
else
    printf "Document embedding was not approved; indexing remains disabled.\n"
fi
systemctl enable --now drivemate-api.service drivemate-cycle.service drivemate-secrets.timer

if systemctl list-unit-files snap.amazon-ssm-agent.amazon-ssm-agent.service --no-legend | grep -q amazon-ssm-agent; then
    systemctl enable --now snap.amazon-ssm-agent.amazon-ssm-agent.service
elif systemctl list-unit-files amazon-ssm-agent.service --no-legend | grep -q amazon-ssm-agent; then
    systemctl enable --now amazon-ssm-agent.service
else
    printf "Expected SSM agent is absent from the selected Ubuntu image.\n" >&2
    exit 1
fi

wait_api() {
    for attempt in $(seq 1 60); do
        if curl --fail --silent http://127.0.0.1:18085/api/v1/health >/dev/null; then
            return 0
        fi
        sleep 2
    done
    return 1
}
wait_api
python3 - <<'PY'
import json
import os
from pathlib import Path
import shlex
import sys
import urllib.error
import urllib.request
import boto3
from botocore.config import Config

def main():
    try:
        session = boto3.Session(region_name="@@REGION@@")
        client = session.client("secretsmanager", config=Config(connect_timeout=5, read_timeout=20,
            retries={"total_max_attempts": 3, "mode": "standard"}))
        secret = json.loads(client.get_secret_value(SecretId="@@APP_SECRET_ARN@@")["SecretString"])
        email = secret.get("DRIVEMATE_INITIAL_EMAIL", "")
        password = secret.get("DRIVEMATE_INITIAL_PASSWORD", "")
        if not email or len(password) < 20:
            raise ValueError("Initial account configuration is missing")
        environment_path = Path("/etc/drivemate/app.env")
        environment_lines = environment_path.read_text().splitlines()
        bootstrap_values = [shlex.split(line.split("=", 1)[1])[0] for line in environment_lines
                            if line.startswith("DRIVEMATE_BOOTSTRAP_TOKEN=")]
        if len(bootstrap_values) != 1 or len(bootstrap_values[0]) < 32:
            raise ValueError("Initial account registration token is missing")
        request = urllib.request.Request("http://127.0.0.1:18085/api/v1/auth/register",
            data=json.dumps({"email": email, "password": password}).encode(),
            headers={"Content-Type": "application/json", "X-DriveMate-Bootstrap-Token": bootstrap_values[0]})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                if response.status != 201:
                    raise ValueError("Initial registration failed")
            print("Initial account created before public traffic was enabled.")
        except urllib.error.HTTPError as error:
            if error.code != 409:
                raise
            print("Initial account already exists; account left unchanged.")
        # The registration privilege exists only while nginx is stopped. Remove
        # the token and restart Spring before any external traffic can arrive.
        temporary = environment_path.with_suffix(".bootstrap-complete")
        descriptor = os.open(temporary, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "w") as output:
            output.write("\n".join(line for line in environment_lines
                         if not line.startswith("DRIVEMATE_BOOTSTRAP_TOKEN=")) + "\n")
        os.replace(temporary, environment_path)
        return 0
    except Exception as error:
        print("Initial account setup failed: " + type(error).__name__, file=sys.stderr)
        return 1

if __name__ == "__main__":
    sys.exit(main())
PY
systemctl restart drivemate-api.service
wait_api
systemctl enable --now nginx.service
curl --fail --silent http://127.0.0.1/api/v1/health >/dev/null
python3 - <<'PY'
import boto3
from botocore.config import Config

def main():
    client = boto3.client("cloudformation", region_name="@@REGION@@",
        config=Config(connect_timeout=5, read_timeout=20, retries={"total_max_attempts": 5, "mode": "standard"}))
    client.signal_resource(StackName="@@STACK_NAME@@", LogicalResourceId="Host",
        UniqueId="drivemate-bootstrap", Status="SUCCESS")
    print("DriveMate bootstrap complete; database and initial account are ready. Document indexing follows its explicit approval flag.")

if __name__ == "__main__":
    main()
PY
