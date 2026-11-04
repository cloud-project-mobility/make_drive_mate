"""No AWS calls: exercise message idempotency, bounded retries, and publication order."""

import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from cycle_worker import PREFIX, Settings, atomic_json, process_message, validate_message


class FakeAws:
    def __init__(self):
        self.objects = {}
        self.operations = []
        self.fail_upload = False

    def read_json(self, key):
        value = self.objects.get(key)
        return json.loads(json.dumps(value)) if value is not None else None

    def write_json(self, key, value):
        self.objects[key] = json.loads(json.dumps(value))
        self.operations.append(("write", key))

    def upload(self, path, key):
        if self.fail_upload:
            raise RuntimeError("fixture upload failure")
        self.operations.append(("upload", key))

    def delete(self, receipt):
        self.operations.append(("delete", receipt))

    def extend(self, receipt):
        self.operations.append(("extend", receipt))


class QueueCycleTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.settings = Settings("ap-northeast-2", "https://sqs.ap-northeast-2.amazonaws.com/123456789012/fixture", "fixture-data", self.root, self.root / "pipeline")
        self.message = {"MessageId": "fixture-message-1", "ReceiptHandle": "fixture-receipt",
                        "Body": '{"kind":"refresh","schema_version":1}'}
        self.job_id = validate_message(self.message)
        self.aws = FakeAws()

    def tearDown(self):
        self.temporary.cleanup()

    def prepared_run(self):
        job_root = self.settings.output_root / "jobs" / self.job_id
        run_dir = job_root / "runs/fixture-run"
        run_dir.mkdir(parents=True)
        summary = {"run_id": "fixture-run", "status": "completed", "production_promoted": False}
        (run_dir / "summary.json").write_text(json.dumps(summary))
        (run_dir / "report.html").write_text("<html>fixture report</html>")
        (job_root / "latest.json").write_text(json.dumps(summary))
        return summary

    def test_duplicate_completed_message_is_deleted_without_running_pipeline(self):
        self.aws.objects[f"{PREFIX}/completed/{self.job_id}.json"] = {"run_id": "past"}
        runner = Mock()
        result = process_message(self.message, self.settings, self.aws, self.root / "unused.env", runner)
        self.assertEqual(result["status"], "duplicate_completed")
        runner.assert_not_called()
        self.assertEqual(self.aws.operations, [("delete", "fixture-receipt")])

    def test_publish_after_uploads_and_mark_before_acknowledgement(self):
        summary = self.prepared_run()
        runner = Mock()
        result = process_message(self.message, self.settings, self.aws, self.root / "unused.env", runner)
        self.assertEqual(result["status"], "completed")
        runner.assert_not_called()
        operations = [kind for kind, _ in self.aws.operations]
        self.assertEqual(operations, ["upload", "upload", "write", "write", "delete"])
        self.assertEqual(self.aws.objects[f"{PREFIX}/latest.json"], summary)
        self.assertEqual(json.loads((self.settings.output_root / "latest.json").read_text()), summary)

    def test_aggregate_remains_group_readable_with_private_worker_umask(self):
        aggregate = self.settings.output_root / "latest.json"
        previous_umask = os.umask(0o077)
        try:
            atomic_json(aggregate, {"run_id": "first"})
            atomic_json(aggregate, {"run_id": "replacement"})
        finally:
            os.umask(previous_umask)
        self.assertEqual(stat.S_IMODE(aggregate.stat().st_mode), 0o640)
        self.assertEqual(json.loads(aggregate.read_text()), {"run_id": "replacement"})
        self.assertFalse(aggregate.with_name("latest.json.tmp").exists())

    def test_failed_upload_does_not_publish_or_delete_and_retry_uses_local_result(self):
        self.prepared_run()
        self.aws.fail_upload = True
        with self.assertRaises(RuntimeError):
            process_message(self.message, self.settings, self.aws, self.root / "unused.env")
        self.assertNotIn(f"{PREFIX}/latest.json", self.aws.objects)
        self.assertFalse(any(kind == "delete" for kind, _ in self.aws.operations))
        self.aws.fail_upload = False
        runner = Mock()
        process_message(self.message, self.settings, self.aws, self.root / "unused.env", runner)
        runner.assert_not_called()

    def test_failed_collection_charges_budget_and_retries_remaining_budget(self):
        budgets = []

        def failing_runner(settings, job_root, env_file, budget, heartbeat, reuse):
            budgets.append(budget)
            path = job_root / "runs" / f"failed-{len(budgets)}" / "data"
            path.mkdir(parents=True)
            (path / "manifest.json").write_text(json.dumps({"complete": False, "request_count": 13}))
            raise RuntimeError("fixture collection failure")

        for _ in range(2):
            with self.assertRaises(RuntimeError):
                process_message(self.message, self.settings, self.aws, self.root / "unused.env", failing_runner)
        self.assertEqual(budgets, [100, 87])
        ledger = self.aws.objects[f"{PREFIX}/jobs/{self.job_id}.json"]
        self.assertEqual(ledger, {"spent_calls": 26, "reserved_calls": 0})
        self.assertFalse(any(kind == "delete" for kind, _ in self.aws.operations))

    def test_interrupted_reserved_budget_cannot_silently_spend_again(self):
        self.aws.objects[f"{PREFIX}/jobs/{self.job_id}.json"] = {"spent_calls": 0, "reserved_calls": 100}
        runner = Mock()
        with self.assertRaises(RuntimeError):
            process_message(self.message, self.settings, self.aws, self.root / "unused.env", runner)
        runner.assert_not_called()

    def test_message_contract_rejects_injected_parameters(self):
        for body in ('{"kind":"refresh","schema_version":true}',
                     '{"kind":"refresh","schema_version":1,"command":"anything"}',
                     '{"kind":"refresh","kind":"other","schema_version":1}', '[]'):
            with self.assertRaises(ValueError):
                validate_message({**self.message, "Body": body})


if __name__ == "__main__":
    unittest.main()
