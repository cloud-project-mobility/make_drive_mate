"""Single EC2/SQS consumer for bounded Onbid refresh jobs and private S3 archives."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import mimetypes
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

PREFIX = "data/cycles"
VISIBILITY_SECONDS = 900
JOB_TIMEOUT_SECONDS = 1800
HEARTBEAT_SECONDS = 60
KST = ZoneInfo("Asia/Seoul")


def log(event, **values):
    print(json.dumps({"event": event, **values}, ensure_ascii=False), flush=True)


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    # Only this aggregate is shared with the API user's deployment group.
    temporary.chmod(0o640)
    temporary.replace(path)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate message keys are not accepted.")
        result[key] = value
    return result


def validate_message(message):
    body = message.get("Body")
    if not isinstance(body, str) or len(body.encode()) > 1024:
        raise ValueError("Unsupported refresh message size.")
    value = json.loads(body, object_pairs_hook=unique_object)
    if (
        not isinstance(value, dict) or set(value) != {"kind", "schema_version"}
        or value["kind"] != "refresh" or type(value["schema_version"]) is not int
        or value["schema_version"] != 1
    ):
        raise ValueError("Only refresh schema version one is supported.")
    identifier = message.get("MessageId")
    if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identifier):
        raise ValueError("A valid SQS message identifier is required.")
    if not isinstance(message.get("ReceiptHandle"), str) or not message["ReceiptHandle"]:
        raise ValueError("A receipt handle is required.")
    return hashlib.sha256(identifier.encode()).hexdigest()


@dataclass(frozen=True)
class Settings:
    region: str
    queue_url: str
    bucket: str
    repo_root: Path
    output_root: Path
    secret_arn: str | None = None
    kms_key: str | None = None

    @classmethod
    def from_env(cls):
        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION", "")
        queue = os.environ.get("DRIVEMATE_CYCLE_QUEUE_URL", "")
        bucket = os.environ.get("DRIVEMATE_DATA_BUCKET", "")
        if not re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-\d", region):
            raise ValueError("Configure an AWS region.")
        if not re.fullmatch(r"https://sqs\." + re.escape(region) + r"\.amazonaws\.com/\d{12}/[A-Za-z0-9_-]+", queue):
            raise ValueError("Configure the regional standard SQS queue URL.")
        if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket):
            raise ValueError("Configure a valid private S3 data bucket.")
        repo = Path(os.environ.get("DRIVEMATE_REPO_ROOT", str(Path(__file__).resolve().parents[2])))
        output = Path(os.environ.get("DRIVEMATE_CYCLE_OUTPUT_ROOT", str(repo / "backend/data/onbid/pipeline")))
        return cls(region, queue, bucket, repo, output,
                   os.environ.get("DRIVEMATE_ONBID_SECRET_ARN"), os.environ.get("DRIVEMATE_DATA_KMS_KEY_ARN"))


class AwsAdapter:
    def __init__(self, settings):
        import boto3
        from boto3.s3.transfer import TransferConfig
        from botocore.config import Config

        session = boto3.Session(region_name=settings.region)
        configuration = Config(connect_timeout=5, read_timeout=35,
                               retries={"total_max_attempts": 3, "mode": "standard"})
        self.s3 = session.client("s3", config=configuration)
        self.sqs = session.client("sqs", config=configuration)
        self.secrets = session.client("secretsmanager", config=configuration)
        self.settings = settings
        self.transfer = TransferConfig(max_concurrency=2)
        self.encryption = {"ServerSideEncryption": "AES256"}
        if settings.kms_key:
            self.encryption = {"ServerSideEncryption": "aws:kms", "SSEKMSKeyId": settings.kms_key}

    def verify_queue(self):
        response = self.sqs.get_queue_attributes(QueueUrl=self.settings.queue_url,
                                                 AttributeNames=["RedrivePolicy"])
        policy = json.loads(response.get("Attributes", {}).get("RedrivePolicy", "{}"))
        if int(policy.get("maxReceiveCount", 0)) != 3 or not policy.get("deadLetterTargetArn"):
            raise ValueError("Configure a dead-letter queue with maxReceiveCount three.")

    def read_json(self, key):
        try:
            response = self.s3.get_object(Bucket=self.settings.bucket, Key=key)
        except self.s3.exceptions.NoSuchKey:
            return None
        with response["Body"] as body:
            raw = body.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError("The S3 control object is too large.")
        return json.loads(raw)

    def write_json(self, key, value):
        self.s3.put_object(Bucket=self.settings.bucket, Key=key,
                           Body=json.dumps(value, ensure_ascii=False, allow_nan=False).encode(),
                           ContentType="application/json", **self.encryption)

    def upload(self, path, key):
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.s3.upload_file(str(path), self.settings.bucket, key,
                            ExtraArgs={"ContentType": content_type, **self.encryption}, Config=self.transfer)

    def receive(self):
        return self.sqs.receive_message(
            QueueUrl=self.settings.queue_url, MaxNumberOfMessages=1, WaitTimeSeconds=20,
            VisibilityTimeout=VISIBILITY_SECONDS,
            MessageSystemAttributeNames=["ApproximateReceiveCount"],
        ).get("Messages", [])

    def extend(self, receipt):
        self.sqs.change_message_visibility(QueueUrl=self.settings.queue_url, ReceiptHandle=receipt,
                                           VisibilityTimeout=VISIBILITY_SECONDS)

    def delete(self, receipt):
        self.sqs.delete_message(QueueUrl=self.settings.queue_url, ReceiptHandle=receipt)

    def onbid_key(self):
        key = os.environ.get("ONBID_SERVICE_KEY", "")
        if not key and self.settings.secret_arn:
            result = self.secrets.get_secret_value(SecretId=self.settings.secret_arn)
            secret = result.get("SecretString", "")
            values = json.loads(secret)
            key = values.get("ONBID_SERVICE_KEY", "")
        if not isinstance(key, str) or not key.strip() or re.search(r"\s", key):
            raise ValueError("The Onbid secret is missing or invalid.")
        return key


class Heartbeat:
    def __init__(self, adapter, receipt):
        self.adapter, self.receipt = adapter, receipt
        self.stop = threading.Event()
        self.failed = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        while not self.stop.wait(HEARTBEAT_SECONDS):
            try:
                self.adapter.extend(self.receipt)
            except Exception:
                self.failed.set()
                return

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.stop.set()
        self.thread.join(timeout=40)

    def check(self):
        if self.failed.is_set():
            raise RuntimeError("The message lease could not be renewed.")


def latest_success(job_root):
    path = job_root / "latest.json"
    if not path.is_file():
        return None
    summary = json.loads(path.read_text(encoding="utf-8"))
    run_id = summary.get("run_id", "")
    if summary.get("status") != "completed" or not re.fullmatch(r"[A-Za-z0-9_-]+", run_id):
        return None
    run_dir = job_root / "runs" / run_id
    return (summary, run_dir) if (run_dir / "summary.json").is_file() else None


def reusable_raw(job_root):
    candidates = sorted((job_root / "runs").glob("*/data/manifest.json"), reverse=True)
    for path in candidates:
        if json.loads(path.read_text(encoding="utf-8")).get("complete"):
            return path.parent
    return None


def run_pipeline(settings, job_root, env_file, budget, heartbeat, reuse=None):
    end = datetime.now(KST).date() - timedelta(days=1)
    start = end - timedelta(days=364)
    command = [sys.executable, str(settings.repo_root / "backend/scripts/onbid_pipeline.py"),
               "--output-root", str(job_root), "--env", str(env_file), "--max-calls", str(budget)]
    command += ["--reuse-run", str(reuse)] if reuse else ["--start", start.isoformat(), "--end", end.isoformat()]
    started = time.monotonic()
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                   cwd=settings.repo_root, start_new_session=True)
        try:
            while process.poll() is None:
                heartbeat.check()
                if time.monotonic() - started > JOB_TIMEOUT_SECONDS:
                    raise TimeoutError("The refresh job exceeded its timeout.")
                time.sleep(1)
            if process.returncode:
                raise RuntimeError("The analysis cycle failed; inspect its local manifest.")
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
    result = latest_success(job_root)
    if result is None:
        raise RuntimeError("The cycle did not produce a successful summary.")
    return result


def process_message(message, settings, adapter, env_file, runner=run_pipeline):
    job_id = validate_message(message)
    receipt = message["ReceiptHandle"]
    marker_key = f"{PREFIX}/completed/{job_id}.json"
    if adapter.read_json(marker_key) is not None:
        adapter.delete(receipt)
        return {"status": "duplicate_completed", "job_id": job_id}
    job_root = settings.output_root / "jobs" / job_id
    job_root.mkdir(parents=True, exist_ok=True)
    ledger_key = f"{PREFIX}/jobs/{job_id}.json"
    ledger = adapter.read_json(ledger_key) or {"spent_calls": 0, "reserved_calls": 0}
    if (
        not isinstance(ledger, dict) or set(ledger) != {"spent_calls", "reserved_calls"}
        or any(type(value) is not int or not 0 <= value <= 100 for value in ledger.values())
        or sum(ledger.values()) > 100
    ):
        raise ValueError("The durable request-budget ledger is invalid.")
    with Heartbeat(adapter, receipt) as heartbeat:
        prepared = latest_success(job_root)
        if prepared is None:
            reuse = reusable_raw(job_root)
            remaining = 100 - int(ledger["spent_calls"]) - int(ledger["reserved_calls"])
            if not reuse and remaining <= 0:
                raise RuntimeError("The message request budget is exhausted or reserved by an interrupted job.")
            previous_runs = set((job_root / "runs").glob("*"))
            if not reuse:
                ledger["reserved_calls"] += remaining
                adapter.write_json(ledger_key, ledger)
            try:
                prepared = runner(settings, job_root, env_file, max(1, remaining), heartbeat, reuse)
            finally:
                # Reservations survive a worker crash; this is intentionally conservative.
                if not reuse:
                    new_runs = set((job_root / "runs").glob("*")) - previous_runs
                    manifests = [path / "data/manifest.json" for path in new_runs]
                    observed = [json.loads(path.read_text(encoding="utf-8")) for path in manifests if path.is_file()]
                    if observed:
                        charged = sum(int(value["request_count"]) for value in observed)
                        if not 0 <= charged <= remaining:
                            raise RuntimeError("The recorded request count exceeds its reservation.")
                        ledger["spent_calls"] += charged
                        ledger["reserved_calls"] -= remaining
                        adapter.write_json(ledger_key, ledger)
        summary, run_dir = prepared
        if summary.get("production_promoted") is not False:
            raise ValueError("A refresh job must not promote a serving model.")
        run_id = summary["run_id"]
        if not re.fullmatch(r"[A-Za-z0-9_-]+", run_id):
            raise ValueError("Invalid generated run identifier.")
        for path in sorted(run_dir.rglob("*")):
            heartbeat.check()
            if path.is_symlink():
                raise ValueError("Symbolic links cannot be archived.")
            if not path.is_file():
                continue
            relative = path.relative_to(run_dir).as_posix()
            if any(part.startswith(".") for part in path.relative_to(run_dir).parts):
                raise ValueError("Private configuration files cannot be archived.")
            if path.suffix not in {".json", ".csv", ".svg", ".html", ".md", ".joblib"}:
                raise ValueError("Unsupported cycle artifact type.")
            adapter.upload(path, f"{PREFIX}/{run_id}/{relative}")
        heartbeat.check()
        # Publish only after every raw/model/report artifact was successfully uploaded.
        adapter.write_json(f"{PREFIX}/latest.json", summary)
        atomic_json(settings.output_root / "latest.json", summary)
        marker = {"run_id": run_id, "completed_at": datetime.now(KST).isoformat(),
                  "production_promoted": False, "spent_calls": ledger["spent_calls"]}
        adapter.write_json(marker_key, marker)
        adapter.delete(receipt)
    return {"status": "completed", "job_id": job_id, "run_id": run_id}


class JobDeadline(RuntimeError):
    pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="Poll once; useful for a controlled service check.")
    args = parser.parse_args()
    os.umask(0o077)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_args: stop.set())
    signal.signal(signal.SIGINT, lambda *_args: stop.set())

    def deadline(*_args):
        raise JobDeadline("The refresh job exceeded its timeout.")

    signal.signal(signal.SIGALRM, deadline)
    try:
        settings = Settings.from_env()
        settings.output_root.mkdir(parents=True, exist_ok=True)
        with (settings.output_root / ".sqs-worker.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            adapter = AwsAdapter(settings)
            adapter.verify_queue()
            key = adapter.onbid_key()
            with tempfile.TemporaryDirectory(prefix="drivemate-key-") as directory:
                env_file = Path(directory) / ".env.onbid.local"
                env_file.write_text("ONBID_SERVICE_KEY=" + key + "\n", encoding="utf-8")
                env_file.chmod(0o600)
                del key
                while not stop.is_set():
                    messages = adapter.receive()
                    for message in messages:
                        signal.alarm(JOB_TIMEOUT_SECONDS)
                        try:
                            result = process_message(message, settings, adapter, env_file)
                            log("cycle_result", **result)
                        except Exception as error:
                            # No DeleteMessage: SQS retries and then its configured DLQ handles failure.
                            log("cycle_failed", error_type=type(error).__name__)
                        finally:
                            signal.alarm(0)
                    if args.once:
                        break
        return 0
    except Exception as error:
        log("worker_failed", error_type=type(error).__name__)
        return 1


if __name__ == "__main__":
    sys.exit(main())
