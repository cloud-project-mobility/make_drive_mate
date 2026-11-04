import json
from pathlib import Path
import tempfile
import unittest

from refresh_secrets import encode_env, read_env, refresh


class FakeSecrets:
    def __init__(self, secret):
        self.secret = secret

    def get_secret_value(self, *, SecretId):
        if SecretId != "synthetic-secret":
            raise AssertionError("Unexpected secret")
        return {"SecretString": json.dumps(self.secret)}


class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        (self.directory / "secret-refresh.json").write_text(json.dumps({"app_secret_arn": "synthetic-secret"}))
        self.app = {"OPENAI_API_KEY": "synthetic-old", "OPENAI_MODEL": "gpt-6-astra", "SPRING_DATASOURCE_PASSWORD": "db-fixed"}
        self.worker = {"ONBID_SERVICE_KEY": "synthetic-onbid-old"}
        (self.directory / "app.env").write_text(encode_env(self.app))
        (self.directory / "worker.env").write_text(encode_env(self.worker))

    def tearDown(self):
        self.temporary.cleanup()

    def test_key_rotation_is_atomic_private_and_does_not_change_database_password(self):
        secret = {"OPENAI_API_KEY": 'synthetic-quote"and\\slash', "ONBID_SERVICE_KEY": "synthetic-new", "DRIVEMATE_DB_PASSWORD": "unapplied"}
        services = refresh(self.directory, FakeSecrets(secret))
        self.assertEqual(services, ["drivemate-api.service", "drivemate-cycle.service"])
        stored = read_env(self.directory / "app.env")
        self.assertEqual(stored["OPENAI_API_KEY"], secret["OPENAI_API_KEY"])
        self.assertEqual(stored["SPRING_DATASOURCE_PASSWORD"], "db-fixed")
        self.assertEqual((self.directory / "app.env").stat().st_mode & 0o777, 0o600)
        self.assertEqual(refresh(self.directory, FakeSecrets(secret)), services)
        for service in services:
            (self.directory / (".restart-" + service)).unlink()
        self.assertEqual(refresh(self.directory, FakeSecrets(secret)), [])

    def test_incomplete_or_unsafe_secret_preserves_existing_files(self):
        before = (self.directory / "app.env").read_bytes()
        with self.assertRaises(ValueError):
            refresh(self.directory, FakeSecrets({"OPENAI_API_KEY": "synthetic-new"}))
        with self.assertRaises(ValueError):
            refresh(self.directory, FakeSecrets({"OPENAI_API_KEY": "synthetic\nunsafe", "ONBID_SERVICE_KEY": "synthetic-new"}))
        self.assertEqual((self.directory / "app.env").read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
