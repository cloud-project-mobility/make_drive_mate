"""Small local health check, with no response-body or credential logging."""
import json
import sys
import urllib.request


def main():
    try:
        mode = sys.argv[1]
        if mode not in {"api", "nginx"}:
            return 1
        port = 18085 if mode == "api" else 8080
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/v1/health", timeout=4) as response:
            value = json.loads(response.read(4097))
        return 0 if value.get("status") == "ok" and value.get("backend") == "spring" else 1
    except Exception:
        return 1


if __name__ == "__main__":
    sys.exit(main())
