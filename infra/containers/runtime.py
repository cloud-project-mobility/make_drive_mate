"""Verified private artifact loading; executable code always comes from the image."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile
import zipfile

MAX_ARCHIVE = 256 * 1024**2
MAX_EXPANDED = 2 * 1024**3
MAX_REPORT = 1024**2
API_MEMBERS = {"model/model_bundle.joblib", "model/metrics.json", "backend/data/onbid/pipeline/latest.json"}


def strict_json(content):
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise ValueError("Duplicate JSON keys")
            value[key] = item
        return value

    def constant(_value):
        raise ValueError("Non-finite JSON number")

    return json.loads(content, object_pairs_hook=pairs, parse_constant=constant)


def safe_key(value):
    if not isinstance(value, str) or not value or len(value) > 1024:
        raise ValueError("Missing object key")
    path = PurePosixPath(value)
    if path.is_absolute() or str(path) != value or any(part in {'.', '..'} for part in path.parts) or any(char in value for char in "\\\r\n\x00"):
        raise ValueError("Unsafe object key")
    return value


def digest(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
        raise ValueError("A SHA256 checksum is required")
    return value


def client_from_env(environment):
    import boto3
    from botocore.config import Config

    region = environment.get("AWS_REGION", "")
    if not re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-\d", region):
        raise ValueError("An explicit AWS region is required")
    # Credentials come from the ECS task role, never application configuration.
    if any(environment.get(key) for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE")):
        raise ValueError("Use an ECS task role instead of static AWS credentials")
    return boto3.Session(region_name=region).client("s3", config=Config(
        connect_timeout=5, read_timeout=60,
        retries={"total_max_attempts": 4, "mode": "standard"}))


def bucket_from_env(environment):
    value = environment.get("DRIVEMATE_RELEASE_BUCKET", "")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", value):
        raise ValueError("A private artifact bucket is required")
    return value


def object_bytes(client, bucket, key, limit):
    response = client.get_object(Bucket=bucket, Key=safe_key(key))
    with response["Body"] as body:
        if int(response.get("ContentLength", 0)) > limit:
            raise ValueError("Object exceeds size limit")
        value = body.read(limit + 1)
    if len(value) > limit:
        raise ValueError("Object exceeds size limit")
    return value


def download_archive(client, bucket, key, expected, destination):
    digest(expected)
    response = client.get_object(Bucket=bucket, Key=safe_key(key))
    calculated = hashlib.sha256()
    total = 0
    with response["Body"] as body, destination.open("xb") as output:
        destination.chmod(0o600)
        if int(response.get("ContentLength", 0)) > MAX_ARCHIVE:
            raise ValueError("Archive exceeds size limit")
        while content := body.read(1024**2):
            total += len(content)
            if total > MAX_ARCHIVE:
                raise ValueError("Archive exceeds size limit")
            calculated.update(content)
            output.write(content)
    if calculated.hexdigest() != expected:
        raise ValueError("Release checksum mismatch")


def extract_data(archive, target, mode):
    if mode not in {"api", "cycle"}:
        raise ValueError("Unsupported artifact mode")
    target.mkdir(parents=True, exist_ok=False)
    hashes = {}
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        if len(entries) > 50000 or sum(item.file_size for item in entries) > MAX_EXPANDED:
            raise ValueError("Archive expansion exceeds limit")
        seen = set()
        for item in entries:
            name = item.filename
            canonical = name.rstrip('/') if item.is_dir() else name
            safe_key(canonical)
            if canonical in seen or stat.S_ISLNK(item.external_attr >> 16) or item.flag_bits & 1:
                raise ValueError("Ambiguous or unsupported archive member")
            seen.add(canonical)
            if any(part.startswith('.') or part in {"credentials.json", "app-secret.json"} for part in PurePosixPath(canonical).parts):
                raise ValueError("Private configuration cannot be in an artifact release")
            # All JAR, scripts, HTML and other archive code are deliberately ignored.
            selected = name in API_MEMBERS or (mode == "cycle" and name.startswith("backend/data/onbid/seed-run/"))
            if item.is_dir() or not selected:
                continue
            if name.startswith("backend/data/onbid/seed-run/") and PurePosixPath(name).suffix not in {".json", ".csv", ".md"}:
                raise ValueError("Unexpected raw data artifact")
            destination = target / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            calculated = hashlib.sha256()
            with bundle.open(item) as source, destination.open("xb") as output:
                while content := source.read(1024**2):
                    calculated.update(content)
                    output.write(content)
            destination.chmod(0o600)
            hashes[name] = calculated.hexdigest()
    if not API_MEMBERS.issubset(hashes):
        raise ValueError("Private release is missing model or analytics data")
    validate_report((target / "backend/data/onbid/pipeline/latest.json").read_bytes())
    return hashes


def validate_report(content):
    if len(content) > MAX_REPORT:
        raise ValueError("Analytics report exceeds limit")
    value = strict_json(content)
    if (not isinstance(value, dict) or value.get("schema_version") != "drivemate-cycle-v1"
            or value.get("status") != "completed" or value.get("production_promoted") is not False
            or value.get("price_kind") != "auction_award"
            or any(not isinstance(value.get(key), dict) for key in ("quality", "model", "charts"))):
        raise ValueError("Analytics report contract failed")
    return value


def refresh_analytics(client, bucket, key, target):
    key = safe_key(key)
    # Exact-prefix ListBucket permission distinguishes absent initial output from denied GET.
    listing = client.list_objects_v2(Bucket=bucket, Prefix=key, MaxKeys=1)
    if not any(item.get("Key") == key for item in listing.get("Contents", [])):
        return False
    content = object_bytes(client, bucket, key, MAX_REPORT)
    validate_report(content)
    write_atomic(target, content)
    return True


def validate_pointer(content):
    if len(content) > 32 * 1024:
        raise ValueError("RAG pointer exceeds limit")
    value = strict_json(content)
    permitted = {"schema_version", "collection_id", "corpus_sha256", "embedding_model", "dimensions", "created_at",
                 "backend", "document_count", "chunk_count", "index_relative_path", "storage"}
    if (not isinstance(value, dict) or set(value) - permitted
            or value.get("schema_version") != "document-rag-v1" or value.get("backend") != "pgvector"
            or value.get("embedding_model") != "text-embedding-3-small" or value.get("dimensions") != 1536
            or not isinstance(value.get("collection_id"), str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value["collection_id"])):
        raise ValueError("Expected a pgvector metadata pointer, without documents or vectors")
    digest(value.get("corpus_sha256"))
    if any(type(value.get(name)) is not int or not 0 < value[name] < 1_000_000 for name in ("document_count", "chunk_count")):
        raise ValueError("RAG collection counts are invalid")
    storage = value.get("storage")
    if (not isinstance(storage, dict) or set(storage) - {"backend", "extension_version", "stored_chunks"}
            or storage.get("backend") != "pgvector" or storage.get("stored_chunks") != value["chunk_count"]):
        raise ValueError("RAG storage metadata is invalid")
    safe_key(value.get("index_relative_path"))
    return value


def write_atomic(path, content, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".drivemate-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def prepare_artifacts(client, environment, runtime, mode):
    bucket = bucket_from_env(environment)
    release_sha = digest(environment.get("DRIVEMATE_RELEASE_SHA256"))
    release_key = safe_key(environment.get("DRIVEMATE_RELEASE_KEY"))
    runtime.mkdir(parents=True, exist_ok=True)
    # Every container start re-verifies the trusted S3 bundle; no executable is extracted.
    with tempfile.TemporaryDirectory(prefix="download-", dir=runtime) as temporary:
        archive = Path(temporary) / "release.zip"
        download_archive(client, bucket, release_key, release_sha, archive)
        artifact_root = Path(tempfile.mkdtemp(prefix="artifacts-", dir=runtime)) / "data"
        hashes = extract_data(archive, artifact_root, mode)
    if mode == "api":
        pointer = object_bytes(client, bucket, environment.get("DRIVEMATE_RAG_POINTER_KEY"), 32 * 1024)
        if hashlib.sha256(pointer).hexdigest() != digest(environment.get("DRIVEMATE_RAG_POINTER_SHA256")):
            raise ValueError("RAG pointer checksum mismatch")
        validate_pointer(pointer)
        write_atomic(artifact_root / "backend/data/rag/active_collection.json", pointer)
    return artifact_root, hashes


def publish_web(app_root, web_root):
    source = app_root / "dist"
    manifest = strict_json((app_root / "image-manifest.json").read_bytes())
    expected = {name[len("app/dist/"):]: checksum for name, checksum in manifest["file_sha256"].items() if name.startswith("app/dist/")}
    if "index.html" not in expected:
        raise ValueError("Verified baked web entry is absent")
    web_root.mkdir(parents=True, exist_ok=True)
    target = web_root / "site"
    if target.exists():
        raise ValueError("Use a fresh task web volume")
    with tempfile.TemporaryDirectory(prefix=".web-", dir=web_root) as temporary:
        staging = Path(temporary) / "site"
        for name, checksum in expected.items():
            safe_key(name)
            content = (source / name).read_bytes()
            if hashlib.sha256(content).hexdigest() != digest(checksum):
                raise ValueError("Baked web content checksum mismatch")
            destination = staging / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
            destination.chmod(0o644)
        staging.rename(target)


def api_environment(environment, app_root, artifacts, hashes, runtime):
    forbidden = {"DRIVEMATE_BOOTSTRAP_TOKEN", "DRIVEMATE_INITIAL_PASSWORD", "DRIVEMATE_INITIAL_EMAIL", "DB_SECRET_ARN", "DRIVEMATE_DB_MASTER_PASSWORD"}
    if any(environment.get(key) for key in forbidden):
        raise ValueError("Bootstrap credentials must never enter a runtime task")
    host = environment.get("DRIVEMATE_DB_HOST", "")
    password = environment.get("DRIVEMATE_DB_PASSWORD", "")
    if not re.fullmatch(r"[A-Za-z0-9.-]+", host) or not password:
        raise ValueError("Application database connection is incomplete")
    if not environment.get("OPENAI_API_KEY") or not environment.get("DRIVEMATE_KNOWLEDGE_ALLOWED_EMAILS"):
        raise ValueError("RAG runtime settings are incomplete")
    result = dict(environment)
    result.pop("ONBID_SERVICE_KEY", None)
    certificate = "/etc/drivemate/rds-global-bundle.pem"
    report_path = runtime / "analytics/latest.json"
    write_atomic(report_path, (artifacts / "backend/data/onbid/pipeline/latest.json").read_bytes())
    result.update({
        "SERVER_ADDRESS": "127.0.0.1", "SERVER_PORT": "18085", "SERVER_FORWARD_HEADERS_STRATEGY": "framework",
        "SERVER_SHUTDOWN": "graceful", "SPRING_LIFECYCLE_TIMEOUT_PER_SHUTDOWN_PHASE": "25s",
        "SPRING_SQL_INIT_MODE": "never", "SPRING_DATASOURCE_USERNAME": "drivemate_app",
        "SPRING_DATASOURCE_PASSWORD": password,
        "SPRING_DATASOURCE_URL": f"jdbc:postgresql://{host}:5432/drivemate?sslmode=verify-full&sslrootcert={certificate}",
        "DRIVEMATE_PYTHON": str(app_root / "venv/bin/python"),
        "DRIVEMATE_ML_WORKER": str(app_root / "backend/scripts/onbid_worker.py"),
        "DRIVEMATE_MODEL_BUNDLE": str(artifacts / "model/model_bundle.joblib"),
        "DRIVEMATE_MODEL_SHA256": hashes["model/model_bundle.joblib"],
        "DRIVEMATE_ANALYTICS_REPORT": str(report_path),
        "DRIVEMATE_RAG_WORKER": str(app_root / "backend/scripts/document_rag.py"),
        "DRIVEMATE_RAG_COLLECTION": str(artifacts / "backend/data/rag/active_collection.json"),
        "DRIVEMATE_RAG_BACKEND": "pgvector", "DRIVEMATE_PG_HOST": host, "DRIVEMATE_PG_DATABASE": "drivemate",
        "DRIVEMATE_PG_USER": "drivemate_app", "DRIVEMATE_PG_PASSWORD": password, "DRIVEMATE_PG_SSLROOTCERT": certificate,
        "DRIVEMATE_PREDICTION_TIMEOUT_SECONDS": "115", "OMP_NUM_THREADS": "2", "OPENBLAS_NUM_THREADS": "2", "MKL_NUM_THREADS": "2",
    })
    for key, value in {"DRIVEMATE_PROVIDER_MODE": "mock", "DRIVEMATE_ALLOW_LLM": "true", "DRIVEMATE_LLM_DAILY_LIMIT": "20", "OPENAI_MODEL": "gpt-6-astra"}.items():
        result.setdefault(key, value)
    result.pop("LOGGING_FILE_NAME", None)
    return result
