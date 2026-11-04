"""Run the local Spring demo with existing private data; never print credentials."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / "backend/data/local-run"


def request(path, body=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-DriveMate-Bootstrap-Token"] = token
    data = None if body is None else json.dumps(body).encode()
    with urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:18085/api/v1/" + path,
            data=data, headers=headers), timeout=15) as response:
        return json.load(response)


def wait_ready(process):
    for _ in range(60):
        if process.poll() is not None:
            raise RuntimeError("Spring stopped; inspect backend/data/local-run/api.log.")
        try:
            if request("health").get("backend") == "spring":
                return
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError("Spring startup timed out; inspect backend/data/local-run/api.log.")


def stop(process):
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner-email", required=True, help="Email reserved for this private local demo")
    args = parser.parse_args()
    email = args.owner_email.strip().lower()
    if "@" not in email or any(character.isspace() for character in email):
        raise ValueError("Provide a valid owner email.")
    with socket.socket() as probe:
        if probe.connect_ex(("127.0.0.1", 18085)) == 0:
            raise RuntimeError("Port 18085 is already in use; leave that server unchanged.")
    os.umask(0o077)
    STATE.mkdir(parents=True, exist_ok=True)
    jar = ROOT / "backend-spring/target/drivemate-api-0.2.0.jar"
    python = ROOT / "backend/data/onbid/.venv-ml/bin/python"
    model = ROOT / "backend/data/onbid/model-20261104-v2-validated/model_bundle.joblib"
    collection = ROOT / "backend/data/rag/local_collection.json"
    latest = ROOT / "backend/data/onbid/pipeline/latest.json"
    for path in (jar, python, model, collection, latest):
        if not path.is_file():
            raise RuntimeError("Local prerequisite is missing: " + str(path.relative_to(ROOT)))
    credentials_path = STATE / "credentials.json"
    if credentials_path.exists():
        credentials = json.loads(credentials_path.read_text())
        if credentials.get("email") != email:
            raise RuntimeError("Existing local owner differs; do not overwrite the local account.")
    else:
        credentials = {"email": email, "password": secrets.token_urlsafe(24)}
        credentials_path.write_text(json.dumps(credentials), encoding="utf-8")
    credentials_path.chmod(0o600)
    environment = dict(os.environ)
    # Forward only explicitly named API settings from the existing ignored local file.
    for line in (ROOT / ".env.llm.local").read_text(encoding="utf-8").splitlines():
        key, separator, value = line.partition("=")
        if separator and key in {"OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_EMBEDDING_MODEL"}:
            environment[key] = value.strip().strip("\"'")
    environment.update({
        "SERVER_ADDRESS": "127.0.0.1", "SERVER_PORT": "18085",
        "SPRING_DATASOURCE_URL": "jdbc:h2:file:" + str(STATE / "db/drivemate")
            + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DEFAULT_NULL_ORDERING=HIGH",
        "SPRING_DATASOURCE_USERNAME": "sa", "SPRING_DATASOURCE_PASSWORD": "",
        "DRIVEMATE_PROVIDER_MODE": "mock", "DRIVEMATE_ALLOW_LLM": "true",
        "DRIVEMATE_KNOWLEDGE_ALLOWED_EMAILS": email, "DRIVEMATE_LLM_DAILY_LIMIT": "20",
        "DRIVEMATE_PYTHON": str(python), "DRIVEMATE_ML_WORKER": str(ROOT / "backend/scripts/onbid_worker.py"),
        "DRIVEMATE_MODEL_BUNDLE": str(model), "DRIVEMATE_MODEL_SHA256": hashlib.sha256(model.read_bytes()).hexdigest(),
        "DRIVEMATE_ANALYTICS_REPORT": str(latest), "DRIVEMATE_RAG_WORKER": str(ROOT / "backend/scripts/document_rag.py"),
        "DRIVEMATE_RAG_COLLECTION": str(collection), "DRIVEMATE_RAG_BACKEND": "local",
        "DRIVEMATE_CORS_ORIGINS": "http://localhost:8081,http://127.0.0.1:8081",
        "DRIVEMATE_PREDICTION_TIMEOUT_SECONDS": "115", "DRIVEMATE_BOOTSTRAP_TOKEN": secrets.token_urlsafe(32),
    })
    process = None
    with (STATE / "api.log").open("a", encoding="utf-8") as log:
        try:
            process = subprocess.Popen(["java", "-Xmx768m", "-jar", str(jar)], cwd=ROOT,
                                       env=environment, stdout=log, stderr=subprocess.STDOUT)
            wait_ready(process)
            try:
                request("auth/register", credentials, environment["DRIVEMATE_BOOTSTRAP_TOKEN"])
            except urllib.error.HTTPError as error:
                if error.code != 409:
                    raise RuntimeError("Local owner setup failed; inspect the API log.") from None
            request("auth/login", credentials)
            stop(process)
            environment.pop("DRIVEMATE_BOOTSTRAP_TOKEN")
            process = subprocess.Popen(["java", "-Xmx768m", "-jar", str(jar)], cwd=ROOT,
                                       env=environment, stdout=log, stderr=subprocess.STDOUT)
            wait_ready(process)
            (STATE / "api.json").write_text(json.dumps({"launcher_pid": os.getpid(), "pid": process.pid,
                "url": "http://127.0.0.1:18085", "database": "local H2", "rag_backend": "local",
                "bootstrap_token_removed": True}), encoding="utf-8")
            print("Local API ready: http://127.0.0.1:18085; credentials are in backend/data/local-run/credentials.json", flush=True)
            print("Database: H2; RAG: local vector index (not AWS pgvector); providers: mock.", flush=True)
            return process.wait()
        finally:
            stop(process)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(0)
    except Exception as error:
        # HTTP response bodies and credentials must not be written to launcher output.
        print("Local startup failed: " + (str(error) if isinstance(error, RuntimeError) else type(error).__name__), flush=True)
        raise SystemExit(1)
