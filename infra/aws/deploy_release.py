"""Package, publish and apply code-only releases; never bundle runtime private data."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile

ROOT = Path("/opt/drivemate")
SINGLE_FILES = (
    "backend-spring/target/drivemate-api-0.2.0.jar",
    "backend/requirements-ml.txt", "backend/requirements-rag.txt",
    "infra/aws/requirements-aws.txt", "infra/aws/cycle_worker.py",
    "infra/aws/refresh_secrets.py", "infra/aws/deploy_release.py",
)
REPLACEMENTS = ("dist", "backend/scripts", *SINGLE_FILES)
REQUIREMENTS = tuple(path for path in SINGLE_FILES if "requirements-" in path)


def sha256(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def revision_value(value):
    if not re.fullmatch(r"[a-f0-9]{40}", value):
        raise ValueError("Source revision must be a lowercase 40-character Git SHA.")
    return value


def archive_value(value):
    if not re.fullmatch(r"[a-f0-9]{64}", value):
        raise ValueError("Archive checksum must be a lowercase SHA-256.")
    return value


def member_allowed(name):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name or any(part.startswith(".") for part in path.parts):
        return False
    if name in SINGLE_FILES or name == "code-release.json":
        return True
    if name.startswith("dist/") and len(path.parts) > 1:
        return True
    return len(path.parts) == 3 and path.parts[:2] == ("backend", "scripts") and path.suffix == ".py" and not path.name.startswith("test_")


def scan_secret(content):
    patterns = (rb"sk-(?:proj-)?[A-Za-z0-9_-]{30,}", rb"(?:AKIA|ASIA)[A-Z0-9]{16}",
                rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")
    if any(re.search(pattern, content) for pattern in patterns):
        raise ValueError("Potential secret found; package refused.")


def package(repo, output, revision):
    revision_value(revision)
    repo = Path(repo).resolve()
    entries = {name: repo / name for name in SINGLE_FILES}
    entries.update({path.relative_to(repo).as_posix(): path for path in (repo / "backend/scripts").glob("*.py")
                    if not path.name.startswith("test_")})
    entries.update({path.relative_to(repo).as_posix(): path for path in (repo / "dist").rglob("*") if path.is_file()})
    if "dist/index.html" not in entries or "backend/scripts/document_rag.py" not in entries:
        raise ValueError("Build artifacts are incomplete.")
    hashes = {}
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    archive = output / "code-release.zip"
    temporary = output / "code-release.zip.tmp"
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for name, source in sorted(entries.items()):
            if not member_allowed(name) or source.is_symlink() or not source.is_file():
                raise ValueError("Unsafe or missing release member.")
            content = source.read_bytes()
            scan_secret(content)
            hashes[name] = hashlib.sha256(content).hexdigest()
            bundle.writestr(name, content)
        manifest = {"schema_version": "drivemate-code-release-v1", "source_revision": revision,
                    "files": hashes, "private_data_included": False, "dependencies_must_match": True}
        bundle.writestr("code-release.json", json.dumps(manifest, sort_keys=True))
    temporary.replace(archive)
    checksum = sha256(archive)
    (output / "code-release.sha256").write_text(checksum + "\n", encoding="ascii")
    (output / "source-revision.txt").write_text(revision + "\n", encoding="ascii")
    return {"source_revision": revision, "archive_sha256": checksum, "members": len(hashes),
            "bytes": archive.stat().st_size, "private_data_included": False}


def inspect_archive(archive, revision, checksum):
    revision_value(revision)
    archive_value(checksum)
    if sha256(archive) != checksum:
        raise ValueError("Release checksum does not match.")
    with zipfile.ZipFile(archive) as bundle:
        infos = bundle.infolist()
        if len(infos) > 30000 or sum(info.file_size for info in infos) > 800_000_000:
            raise ValueError("Code release exceeds the size limit.")
        names = [info.filename for info in infos]
        if len(names) != len(set(names)) or any(not member_allowed(name) for name in names):
            raise ValueError("Duplicate or unapproved release members.")
        if any(stat.S_ISLNK(info.external_attr >> 16) or info.is_dir() for info in infos):
            raise ValueError("Release links and explicit directory entries are not accepted.")
        manifest = json.loads(bundle.read("code-release.json"))
        if manifest.get("source_revision") != revision or manifest.get("schema_version") != "drivemate-code-release-v1":
            raise ValueError("Release identity mismatch.")
        if set(manifest["files"]) != set(names) - {"code-release.json"}:
            raise ValueError("Release manifest member mismatch.")
        required = {*SINGLE_FILES, "dist/index.html", "backend/scripts/onbid_worker.py", "backend/scripts/document_rag.py"}
        if not required.issubset(names):
            raise ValueError("Release lacks required runtime files.")
        for name, expected in manifest["files"].items():
            content = bundle.read(name)
            if hashlib.sha256(content).hexdigest() != expected:
                raise ValueError("Release member checksum mismatch.")
            scan_secret(content)
    return manifest


def aws_clients(region):
    import boto3
    from botocore.config import Config
    session = boto3.Session(region_name=region)
    config = Config(connect_timeout=10, read_timeout=30, retries={"mode": "standard", "total_max_attempts": 3})
    return session.client("s3", config=config), session.client("ssm", config=config)


def release_key(revision, checksum):
    return "releases/code/" + revision_value(revision) + "/" + archive_value(checksum) + ".zip"


def publish(archive, revision, checksum, region, bucket, instance, document):
    inspect_archive(archive, revision, checksum)
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket):
        raise ValueError("Invalid deployment bucket.")
    if not re.fullmatch(r"i-[a-f0-9]{8,17}", instance) or not re.fullmatch(r"[A-Za-z0-9_.-]{3,128}", document):
        raise ValueError("Invalid fixed deployment target.")
    s3, ssm = aws_clients(region)
    key = release_key(revision, checksum)
    s3.upload_file(str(archive), bucket, key, ExtraArgs={"ServerSideEncryption": "AES256"})
    response = ssm.send_command(DocumentName=document, InstanceIds=[instance],
                                Parameters={"SourceRevision": [revision], "ArchiveSha256": [checksum]},
                                TimeoutSeconds=900, Comment="DriveMate reviewed code release " + revision[:12])
    command_id = response["Command"]["CommandId"]
    deadline = time.monotonic() + 960
    while time.monotonic() < deadline:
        try:
            invocation = ssm.get_command_invocation(CommandId=command_id, InstanceId=instance)
        except ssm.exceptions.InvocationDoesNotExist:
            time.sleep(5)
            continue
        status = invocation["Status"]
        if status == "Success":
            return {"status": "deployed", "source_revision": revision, "command_id": command_id}
        if status in {"Failed", "Cancelled", "TimedOut", "Cancelling"}:
            # SSM output is deliberately omitted; logs may contain runtime material.
            raise RuntimeError("Deployment did not succeed: " + status)
        time.sleep(5)
    raise RuntimeError("Deployment status timed out; inspect SSM before retrying.")


def service(action, name, check=True):
    subprocess.run(["systemctl", action, name], check=check, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=150)


def healthy(attempts=45):
    for _ in range(attempts):
        try:
            with urllib.request.urlopen("http://127.0.0.1:18085/api/v1/health", timeout=2) as response:
                if response.status == 200 and json.load(response).get("status") == "ok":
                    return True
        except (OSError, ValueError, urllib.error.URLError):
            pass
        time.sleep(2)
    return False


def ensure_existing_dependencies(stage, root):
    for relative in REQUIREMENTS:
        current = root / relative
        if not current.is_file() or current.read_bytes() != (stage / relative).read_bytes():
            raise ValueError("Dependency lock changed; perform a reviewed environment migration before code deployment.")


def apply_release(revision, checksum, bucket, region):
    import fcntl
    if os.geteuid() != 0:
        raise RuntimeError("The fixed deployment command must run as root.")
    root = ROOT.resolve()
    if root != Path("/opt/drivemate") or root.is_symlink():
        raise RuntimeError("Unexpected application root.")
    lock = open("/var/lock/drivemate-deploy.lock", "w")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    directory = root / ".releases" / (revision_value(revision) + "-" + archive_value(checksum)[:12])
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    archive = directory / "code-release.zip"
    stage = directory / "staged"
    state_path = directory / "deployment-state.json"
    if state_path.is_file():
        state = json.loads(state_path.read_text())
        if state.get("status") == "healthy":
            return {"status": "already_deployed", "source_revision": revision}
        if state.get("status") not in {"rolled_back", "prepared"}:
            raise RuntimeError("An interrupted deployment needs operator recovery; no files were changed.")
    s3, _ = aws_clients(region)
    s3.download_file(bucket, release_key(revision, checksum), str(archive))
    inspect_archive(archive, revision, checksum)
    if stage.exists():
        # Fixed, resolved version path under /opt/drivemate/.releases only.
        shutil.rmtree(stage)
    stage.mkdir(mode=0o755)
    with zipfile.ZipFile(archive) as bundle:
        bundle.extractall(stage)
    for item in stage.rglob("*"):
        item.chmod(0o755 if item.is_dir() else 0o644)
    ensure_existing_dependencies(stage, root)
    try:
        return activate_release(root, directory, stage, revision, checksum)
    finally:
        lock.close()


def activate_release(root, directory, stage, revision, checksum):
    """Replace only fixed code paths; separate function permits real-file rollback tests."""
    backup = directory / "backup"
    state_path = directory / "deployment-state.json"
    if backup.exists():
        raise RuntimeError("Previous backup exists; preserve it and use a new reviewed release.")
    backup.mkdir(mode=0o700)
    moved = []

    def record(status):
        state_path.write_text(json.dumps({"status": status, "source_revision": revision,
                                          "archive_sha256": checksum, "replaced": moved}))

    record("prepared")
    try:
        service("stop", "drivemate-cycle.service")
        service("stop", "drivemate-api.service")
        service("stop", "nginx.service")
        record("updating")
        for relative in REPLACEMENTS:
            target, source, previous = root / relative, stage / relative, backup / relative
            if target.is_symlink() or not target.resolve().is_relative_to(root):
                raise ValueError("Unexpected deployment target link.")
            previous.parent.mkdir(parents=True, exist_ok=True)
            had_previous = target.exists()
            if had_previous:
                target.rename(previous)
            moved.append({"path": relative, "had_previous": had_previous})
            record("updating")
            source.rename(target)
        subprocess.run(["nginx", "-t"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        service("start", "drivemate-api.service")
        if not healthy():
            raise RuntimeError("New API failed its readiness check.")
        service("start", "nginx.service")
        with urllib.request.urlopen("http://127.0.0.1/api/v1/health", timeout=5) as response:
            if response.status != 200:
                raise RuntimeError("Reverse proxy readiness check failed.")
        service("start", "drivemate-cycle.service")
        record("healthy")
        (root / "code-release.json").write_text((stage / "code-release.json").read_text())
        return {"status": "deployed", "source_revision": revision, "health": "passed"}
    except Exception:
        service("stop", "drivemate-api.service", check=False)
        service("stop", "nginx.service", check=False)
        for item in reversed(moved):
            target, previous = root / item["path"], backup / item["path"]
            if target.exists():
                failed = directory / "failed" / item["path"]
                failed.parent.mkdir(parents=True, exist_ok=True)
                target.rename(failed)
            if item["had_previous"]:
                previous.rename(target)
        service("start", "drivemate-api.service", check=False)
        rollback_healthy = healthy()
        service("start", "nginx.service", check=False)
        service("start", "drivemate-cycle.service", check=False)
        record("rolled_back" if rollback_healthy else "rollback_needs_attention")
        raise RuntimeError("New release failed; " + ("previous API restored." if rollback_healthy else "operator recovery is required.")) from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("package", "inspect", "publish", "apply"))
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--output", type=Path, default=Path("release-artifacts"))
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--sha256")
    parser.add_argument("--region", default=os.environ.get("AWS_REGION"))
    parser.add_argument("--bucket", default=os.environ.get("AWS_S3_BUCKET"))
    parser.add_argument("--instance", default=os.environ.get("AWS_INSTANCE_ID"))
    parser.add_argument("--document", default=os.environ.get("AWS_SSM_DOCUMENT"))
    args = parser.parse_args()
    try:
        if args.command == "package":
            result = package(args.repo, args.output, args.revision)
        elif args.command == "inspect":
            result = inspect_archive(args.archive, args.revision, args.sha256)
            result = {"status": "verified", "source_revision": result["source_revision"], "files": len(result["files"])}
        elif args.command == "publish":
            result = publish(args.archive, args.revision, args.sha256, args.region, args.bucket, args.instance, args.document)
        else:
            result = apply_release(args.revision, args.sha256, args.bucket, args.region)
        print(json.dumps(result))
        return 0
    except Exception as error:
        print("Deployment failed: " + type(error).__name__ + "; inspect protected deployment state.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
