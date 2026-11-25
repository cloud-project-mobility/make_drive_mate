"""Local source scanner. Findings report only paths and rule IDs, never matches.

This is a pre-publication helper, not proof that no possible secret exists.
It scans source and output diagnostics against local .env values, plus common
token patterns. Runtime/dependency directories and .env itself are excluded.
"""

import json
import os
import re
import subprocess
from pathlib import Path
from urllib.parse import quote

from hyundai_experiments.config import PROJECT_ROOT, Settings

SKIP_DIRS = {
    ".git",
    ".venv",
    ".tools",
    ".python-runtime",
    ".uv-cache",
    "__pycache__",
    ".pytest_cache",
    ".ruff_cache",
    "build",
    "dist",
}
PATTERNS = {
    "jwt_literal": re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),
    "bearer_literal": re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{12,}"),
    "private_key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "environment_value": re.compile(
        r"(?m)^[ \t]*HYUNDAI_(?:SAMPLE_TOKEN|SAMPLE_CAR_ID|CLIENT_SECRET|CLIENT_ID)"
        r"[ \t]*=[ \t]*[^\s#\r\n][^\r\n]*"
    ),
}


def scan_project(root: Path) -> dict[str, object]:
    findings: list[dict[str, str]] = []
    settings = Settings.from_env_file(root / ".env")
    values = settings.sensitive_values()
    scanned = 0
    for directory, dirs, files in os.walk(root):
        dirs[:] = [
            name
            for name in dirs
            if name not in SKIP_DIRS
            and not name.startswith(".venv-")
            and not name.endswith(".egg-info")
            and not (Path(directory) / name).is_symlink()
        ]
        for name in sorted(files):
            path = Path(directory) / name
            relative = path.relative_to(root).as_posix()
            if (
                name == ".env"
                or name.endswith(".local.env")
                or (name.startswith(".env.") and name != ".env.example")
                or path.is_symlink()
            ):
                continue
            try:
                content = path.read_bytes()
            except OSError:
                findings.append({"path": relative, "rule": "unreadable_file"})
                continue
            scanned += 1
            if any(
                value.encode() in content or quote(value, safe="").encode() in content
                for value in values
            ):
                findings.append({"path": relative, "rule": "matches_local_secret"})
            text = content.decode("utf-8", errors="replace")
            for rule, pattern in PATTERNS.items():
                if pattern.search(text):
                    findings.append({"path": relative, "rule": rule})
    git = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
        check=False,
    )
    git_checked = git.returncode == 0
    if git_checked:
        tracked = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z"], capture_output=True, text=True, check=False
        )
        for name in tracked.stdout.split("\0"):
            parts = Path(name).parts
            if name and (
                parts[0] in SKIP_DIRS | {"output"}
                or (Path(name).name.startswith(".env") and name != ".env.example")
            ):
                findings.append({"path": name, "rule": "sensitive_path_tracked"})
    return {
        "passed": not findings,
        "scanned_files": scanned,
        "configured_sensitive_value_count": len(values),
        "git_index_checked": git_checked,
        "findings": findings,
        "scope": "source and output; excludes local settings and dependency/runtime directories",
    }


if __name__ == "__main__":
    report = scan_project(PROJECT_ROOT)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(0 if report["passed"] else 1)
