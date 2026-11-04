"""Refresh API keys without exposing secrets or using the RDS master at runtime."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile


def read_env(path):
    result = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            key, value = shlex.split(line)[0].split("=", 1)
            result[key] = value
    return result


def encode_env(values):
    lines = []
    for key, value in values.items():
        if any(character in value for character in "\r\n\x00"):
            raise ValueError("Secret contains unsupported characters")
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        lines.append(key + '="' + escaped + '"')
    return "\n".join(lines) + "\n"


def update_file(path, values):
    content = encode_env(values)
    if path.read_text(encoding="utf-8") == content:
        return False
    descriptor, name = tempfile.mkstemp(prefix=".secret-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(name, 0o600)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    return True


def refresh(directory, client):
    configuration = json.loads((directory / "secret-refresh.json").read_text())
    secret = json.loads(client.get_secret_value(SecretId=configuration["app_secret_arn"])["SecretString"])
    app = read_env(directory / "app.env")
    worker = read_env(directory / "worker.env")
    for key in ("OPENAI_API_KEY", "ONBID_SERVICE_KEY"):
        if not isinstance(secret.get(key), str) or not secret[key]:
            raise ValueError("Application key is absent")
    # DB password changes require the explicit role-alter deployment workflow.
    app["OPENAI_API_KEY"] = secret["OPENAI_API_KEY"]
    app["OPENAI_MODEL"] = secret.get("OPENAI_MODEL", app["OPENAI_MODEL"])
    app["DRIVEMATE_KNOWLEDGE_ALLOWED_EMAILS"] = secret.get("DRIVEMATE_KNOWLEDGE_ALLOWED_EMAILS", "")
    worker["ONBID_SERVICE_KEY"] = secret["ONBID_SERVICE_KEY"]
    encode_env(app)
    encode_env(worker)
    changed = []
    for filename, values, service in (
        ("app.env", app, "drivemate-api.service"),
        ("worker.env", worker, "drivemate-cycle.service"),
    ):
        path = directory / filename
        pending = directory / (".restart-" + service)
        if path.read_text(encoding="utf-8") != encode_env(values):
            # Keep a durable retry marker if the process fails after updating the file.
            pending.touch(mode=0o600)
            update_file(path, values)
        if pending.exists():
            changed.append(service)
    return changed


def main():
    try:
        import boto3
        from botocore.config import Config
        directory = Path("/etc/drivemate")
        configuration = json.loads((directory / "secret-refresh.json").read_text())
        client = boto3.client("secretsmanager", region_name=configuration["region"],
            config=Config(connect_timeout=5, read_timeout=10, retries={"total_max_attempts": 3, "mode": "standard"}))
        changed = refresh(directory, client)
        for service in changed:
            subprocess.run(["systemctl", "restart", service], check=True)
            (directory / (".restart-" + service)).unlink(missing_ok=True)
        if changed:
            print("Refreshed service credentials: " + ", ".join(changed))
        return 0
    except Exception as error:
        print("Secret refresh failed: " + type(error).__name__, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
