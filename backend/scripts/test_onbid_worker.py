"""Worker boundary tests: no network requests and no real credentials."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from onbid_model import FEATURES, load_bundle, train
from onbid_worker import WorkerError, parse_request, process_request
from test_onbid_model import fixture_data


class WorkerBoundaryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name)
        fixture_data().to_csv(cls.root / "fixture.csv", index=False)
        train(cls.root / "fixture.csv", cls.root / "model", n_estimators=3, n_jobs=1)
        cls.bundle_path = cls.root / "model/model_bundle.joblib"
        cls.bundle = load_bundle(cls.bundle_path)
        row = cls.bundle["reference_train"].iloc[10][FEATURES].to_dict()
        row["engine_cc"] = None
        cls.request = {"vehicle": row, "months": [0, 6, 12]}

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_strict_json_rejects_nan_duplicate_keys_and_unknown_fields(self):
        for raw in (
            b'{"vehicle": null, "vehicle": {}}', b'{"monthly_km": NaN}',
            b'{"model_path": "/tmp/untrusted.joblib"}', b'[]', b'\xff',
            b' ' * 32769,
        ):
            with self.subTest(raw=raw[:40]), self.assertRaises(WorkerError):
                parse_request(raw)

    def test_numbers_and_months_require_correct_json_types(self):
        for field, value in (("months", [True]), ("months", [0, 0]), ("use_llm", "true"),
                             ("monthly_km", -1), ("monthly_km", 10**400),
                             ("monthly_upkeep_krw", True)):
            request = {**self.request, field: value}
            with self.subTest(field=field), self.assertRaises(WorkerError):
                parse_request(json.dumps(request).encode())

    def test_cli_returns_one_json_object_and_no_diagnostic_output(self):
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("onbid_worker.py")),
             "--model-bundle", str(self.bundle_path)],
            input=json.dumps(self.request), capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(result.stderr, "")
        self.assertEqual(len(result.stdout.splitlines()), 1)
        response = json.loads(result.stdout)
        self.assertTrue(response["ok"])
        self.assertEqual(response["explanation"]["mode"], "template")
        self.assertEqual(response["evidence"]["llm_status"], "not_called")
        self.assertNotIn("vehicle_group_id", response["evidence"])

    def test_llm_requires_server_permission_before_credentials_are_read(self):
        request = parse_request(json.dumps({**self.request, "use_llm": True}).encode())
        with patch("onbid_explain.load_openai_config") as loading:
            with self.assertRaises(WorkerError) as raised:
                process_request(request, self.bundle, env_file="/private/local.env")
            loading.assert_not_called()
        self.assertEqual(raised.exception.code, "LLM_DISABLED")

    def test_missing_model_errors_do_not_include_server_path(self):
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("onbid_worker.py")),
             "--model-bundle", str(self.root / "private/missing-secret-location.joblib")],
            input=json.dumps(self.request), capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 3)
        self.assertEqual(json.loads(result.stdout)["error"]["code"], "MODEL_UNAVAILABLE")
        self.assertNotIn("missing-secret-location", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
