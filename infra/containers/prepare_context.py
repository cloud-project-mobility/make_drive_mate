"""Create a new, code-only Docker context. Private runtime artifacts are never inputs."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys

REQUIRED = (
    "backend-spring/target/drivemate-api-0.2.0.jar",
    "backend/requirements-ml.txt", "backend/requirements-rag.txt",
    "infra/aws/requirements-aws.txt", "infra/aws/cycle_worker.py",
)
CONTAINER_FILES = ("entrypoint.py", "runtime.py", "healthcheck.py", "nginx.conf")


def collect(repo):
    repo = repo.resolve(strict=True)
    members = {}

    def add(relative, target):
        source = repo / relative
        if not source.is_file() or source.is_symlink() or not source.resolve().is_relative_to(repo):
            raise ValueError("Missing or unsafe code input")
        if any(part.startswith('.') or part == '__pycache__' for part in Path(relative).parts):
            raise ValueError("Private code input rejected")
        members[target] = source

    for name in REQUIRED:
        add(name, "app/" + name)
    for source in sorted((repo / "backend/scripts").glob("*.py")):
        if not source.name.startswith("test_"):
            add(source.relative_to(repo), "app/" + source.relative_to(repo).as_posix())
    dist = repo / "dist"
    if not (dist / "index.html").is_file():
        raise ValueError("Export the reviewed web build first")
    for source in sorted(dist.rglob("*")):
        if source.is_symlink():
            raise ValueError("Web build symlinks are not accepted")
        if source.is_file():
            relative = source.relative_to(repo)
            if source.suffix.lower() not in {".html", ".js", ".json", ".css", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico", ".ttf", ".woff", ".woff2", ".txt"}:
                raise ValueError("Unexpected web build artifact")
            add(relative, "app/" + relative.as_posix())
    for name in CONTAINER_FILES:
        add("infra/containers/" + name, "container/" + name)
    for name in ("Dockerfile",):
        add("infra/containers/" + name, name)
    ignore = repo / "infra/containers/.dockerignore"
    if not ignore.is_file() or ignore.is_symlink() or not ignore.resolve().is_relative_to(repo):
        raise ValueError("Docker context filter is missing")
    members[".dockerignore"] = ignore
    for source, target in (("backend/requirements-ml.txt", "ml.txt"),
                           ("backend/requirements-rag.txt", "rag.txt"),
                           ("infra/aws/requirements-aws.txt", "aws.txt")):
        add(source, "requirements/" + target)
    return members


def prepare(repo, output):
    members = collect(repo)
    output = output.resolve()
    if output.exists():
        raise ValueError("Use a new context directory; existing directories are never overwritten")
    output.mkdir(parents=True, mode=0o700)
    hashes = {}
    for target, source in members.items():
        destination = output / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        hashes[target] = hashlib.sha256(destination.read_bytes()).hexdigest()
    manifest = {"schema_version": "drivemate-image-code-v1", "file_sha256": hashes,
                "private_runtime_data_included": False}
    manifest_path = output / "app/image-manifest.json"
    manifest_path.write_text(json.dumps(manifest, sort_keys=True) + "\n", encoding="utf-8")
    return {"files": len(hashes), "private_runtime_data_included": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.repo, args.output)))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error_type": type(error).__name__}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
