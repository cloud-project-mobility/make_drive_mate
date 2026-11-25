"""Run the storage regression and measure actual SQL statements on a disposable loopback PostgreSQL."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import tempfile
from datetime import UTC, datetime
from xml.etree import ElementTree


def run(command, *, cwd=None, env=None, stdin=None):
    return subprocess.run(command, cwd=cwd, env=env, input=stdin, text=True, capture_output=True, check=True)


def classpath(project):
    report = next((project / "target/surefire-reports").glob("TEST-*.xml"))
    return ElementTree.parse(report).find(".//property[@name='java.class.path']").get("value")


def count_sql(log, values):
    cases = {}
    active = None
    for line in log.splitlines():
        marker = re.search(r"SELECT 'dm_probe_(begin|end)_(\w+)'", line)
        if marker:
            phase, label = marker.groups()
            active = label if phase == "begin" else None
            if active:
                cases[active] = {"statements": 0, "writes": 0}
            continue
        statement = re.search(r"(?:execute [^:]+|statement):\s*(SELECT|INSERT|UPDATE|DELETE)\b", line, re.I)
        if active and statement:
            cases[active]["statements"] += 1
            cases[active]["writes"] += statement[1].upper() != "SELECT"
    for label, vehicle, snapshot in re.findall(r"^RESULT (\w+) (\d+) (\d+)$", values, re.M):
        if cases[label]["statements"] < 1:
            raise ValueError("No SQL observed for " + label)
        if label != "manual_update":
            cases[label].update(vehicle_km=int(vehicle), snapshot_km=int(snapshot))
    if set(cases) != {"create", "newer", "duplicate", "older", "manual_update"}:
        raise ValueError("Incomplete measurement")
    return cases


def measure(args, env, log, temp):
    output = Path(__file__).resolve().parent / "logs"
    output.mkdir(exist_ok=True)
    results = {"utc": datetime.now(UTC).isoformat(), "engine": run([args.bin / "postgres", "--version"], env=env).stdout.strip()}
    for label, project in [("before", args.baseline), ("after", args.candidate)]:
        cp = classpath(project)
        classes = temp / label
        classes.mkdir()
        run(["javac", "-cp", cp, "-d", classes, Path(__file__).with_name("SampleRefreshProbe.java")], env=env)
        first_byte = log.stat().st_size
        proc = run(["java", "-cp", str(classes) + os.pathsep + cp, "SampleRefreshProbe"], cwd=project, env=env)
        with log.open("rb") as server:
            server.seek(first_byte)
            results[label] = count_sql(server.read().decode(), proc.stdout)
    mvn = subprocess.run([args.maven, "--offline", "-B", "-Dtest=HyundaiSampleOrderingTest", "test"],
                         cwd=args.candidate, env=env, capture_output=True, text=True)
    (output / "db-postgres.txt").write_text(mvn.stdout + mvn.stderr)
    results["postgres_junit_exit"] = mvn.returncode
    (output / "postgres.json").write_text(json.dumps(results, indent=2) + "\n")
    mvn.check_returncode()
    sql = (Path(__file__).with_name("lookup-plan.sql")).read_text()
    plan = run([args.bin / "psql", "-h", "127.0.0.1", "-p", env["DRIVEMATE_TEST_PG_PORT"], "-U", "hyundai_review",
                "-d", "postgres", "-XqAt", "-v", "ON_ERROR_STOP=1"], env=env, stdin=sql)
    results["lookup_plan"] = json.loads(plan.stdout)
    results["synthetic_plan_fixture"] = {"accounts": 4000, "registered_vehicles": 12000, "sample_rows": 4000}
    assert results["after"]["older"]["snapshot_km"] == results["after"]["older"]["vehicle_km"] == 1100
    assert all(results["after"][k]["writes"] == 0 for k in ("duplicate", "older"))
    assert all(results["after"][k]["statements"] < results["before"][k]["statements"] for k in results["after"])
    (output / "postgres.json").write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps({k: results[k] for k in ("engine", "before", "after", "postgres_junit_exit")}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("bin", "share", "baseline", "candidate", "maven"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="dm-pg-") as folder:
        temp = Path(folder)
        data, log = temp / "data", temp / "postgres.log"
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = str(sock.getsockname()[1])
        password = secrets.token_urlsafe(30)
        env = dict(os.environ, DRIVEMATE_TEST_PG_PORT=port, DRIVEMATE_TEST_PG_PASSWORD=password, PGPASSWORD=password)
        run([args.bin / "initdb", "-D", data, "-L", args.share, "-U", "hyundai_review", "--auth-local=trust",
             "--auth-host=scram-sha-256", "--encoding=UTF8", "--no-locale", "--pwfile=/dev/stdin"], env=env, stdin=password + "\n")
        options = f"-h 127.0.0.1 -p {port} -k {temp} -c log_statement=all"
        run([args.bin / "pg_ctl", "-D", data, "-l", log, "-o", options, "-w", "start"], env=env)
        try:
            measure(args, env, log, temp)
        finally:
            run([args.bin / "pg_ctl", "-D", data, "-m", "fast", "-w", "stop"], env=env)


if __name__ == "__main__":
    main()
