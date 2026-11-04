"""ECS/Kubernetes runtime roles. No schema creation, owner registration or secret fetch."""
from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading

from runtime import (api_environment, bucket_from_env, client_from_env,
                     prepare_artifacts, publish_web, refresh_analytics, safe_key)

APP = Path("/opt/drivemate")
RUNTIME = APP / "runtime"
WEB = Path("/srv/drivemate-web")


def log(event, **counts):
    print(json.dumps({"event": event, **counts}), flush=True)


def analytics_refresh(client, environment, target, stopped):
    key = environment.get("DRIVEMATE_ANALYTICS_LATEST_KEY")
    if not key:
        return
    safe_key(key)
    bucket = bucket_from_env(environment)
    while not stopped.wait(60):
        try:
            refresh_analytics(client, bucket, key, target)
        except Exception as error:
            log("analytics_refresh_failed", error_type=type(error).__name__)


def supervise(command, environment, client=None):
    stopped = threading.Event()
    process = subprocess.Popen(command, env=environment, start_new_session=True)

    def stop(_number, _frame):
        stopped.set()
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    if client is not None:
        thread = threading.Thread(target=analytics_refresh, args=(client, environment, Path(environment["DRIVEMATE_ANALYTICS_REPORT"]), stopped), daemon=True)
        thread.start()
    try:
        return process.wait()
    finally:
        stopped.set()
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)


def main():
    os.umask(0o077)
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in {"api", "nginx", "cycle"}:
            raise ValueError("Choose api, nginx or cycle")
        mode = sys.argv[1]
        environment = dict(os.environ)
        if mode == "nginx":
            if not (WEB / "site/index.html").is_file():
                raise ValueError("API must publish the baked web build before nginx starts")
            temporary = Path("/tmp/drivemate-nginx")
            for name in ("client", "proxy", "fastcgi", "uwsgi", "scgi"):
                (temporary / name).mkdir(parents=True, exist_ok=True)
            os.execv("/usr/sbin/nginx", ["nginx", "-c", str(APP / "container/nginx.conf"), "-g", "daemon off;"])
        client = client_from_env(environment)
        artifacts, hashes = prepare_artifacts(client, environment, RUNTIME, mode)
        if mode == "api":
            publish_web(APP, WEB)
            environment = api_environment(environment, APP, artifacts, hashes, RUNTIME)
            log("runtime_artifacts_verified", model_embedded_in_image=False)
            command = ["/usr/bin/java", "-Xms128m", "-Xmx768m", "-jar", str(APP / "backend-spring/target/drivemate-api-0.2.0.jar")]
            return supervise(command, environment, client)
        if not environment.get("ONBID_SERVICE_KEY"):
            raise ValueError("Cycle task requires its own Onbid key")
        # Cycle role has no database, owner or OpenAI credentials.
        for name in tuple(environment):
            if name.startswith(("OPENAI_", "SPRING_DATASOURCE_", "DRIVEMATE_PG_")) or name in {"DRIVEMATE_DB_PASSWORD", "DRIVEMATE_INITIAL_PASSWORD", "DRIVEMATE_BOOTSTRAP_TOKEN"}:
                environment.pop(name)
        environment.update({"DRIVEMATE_REPO_ROOT": str(APP), "DRIVEMATE_CYCLE_OUTPUT_ROOT": str(RUNTIME / "cycles"), "AWS_DEFAULT_REGION": environment["AWS_REGION"]})
        environment.pop("DRIVEMATE_ONBID_SECRET_ARN", None)
        command = [str(APP / "venv/bin/python"), str(APP / "infra/aws/cycle_worker.py"), "--once"]
        return supervise(command, environment)
    except Exception as error:
        # SDK/DB exceptions may contain sensitive context; never print their messages.
        log("container_start_failed", error_type=type(error).__name__)
        return 1


if __name__ == "__main__":
    sys.exit(main())
