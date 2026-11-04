import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import deploy_release as deploy


class ReleaseTests(unittest.TestCase):
    def create_repo(self, path):
        for name in (*deploy.SINGLE_FILES, "dist/index.html", "backend/scripts/onbid_worker.py", "backend/scripts/document_rag.py"):
            target = path / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("synthetic test fixture")
        (path / ".env.llm.local").write_text("NEVER_PACKAGE=test-private-value")
        (path / "backend/data/rag").mkdir(parents=True)
        (path / "backend/data/rag/private.json").write_text("never package private documents")
        return path

    def test_code_package_excludes_secrets_and_private_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.create_repo(Path(directory) / "repo")
            output = Path(directory) / "release"
            result = deploy.package(root, output, "a" * 40)
            manifest = deploy.inspect_archive(output / "code-release.zip", "a" * 40, result["archive_sha256"])
            self.assertFalse(manifest["private_data_included"])
            self.assertFalse(any("backend/data" in name or ".env" in name for name in manifest["files"]))

    def test_member_allowlist_prevents_path_escape_and_runtime_data(self):
        for name in ("../dist/a", "/dist/a", "dist/../../etc/passwd", "dist/.env", "model/model_bundle.joblib",
                     "backend/data/rag/active_collection.json", "backend/scripts/test_private.py"):
            self.assertFalse(deploy.member_allowed(name), name)
        self.assertTrue(deploy.member_allowed("dist/_expo/static/js/index.js"))

    def test_checksum_and_source_identity_cannot_be_swapped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.create_repo(Path(directory) / "repo")
            output = Path(directory) / "release"
            result = deploy.package(root, output, "a" * 40)
            for revision, checksum in (("b" * 40, result["archive_sha256"]), ("a" * 40, "0" * 64)):
                with self.assertRaises(ValueError):
                    deploy.inspect_archive(output / "code-release.zip", revision, checksum)

    def test_dependency_changes_stop_before_any_service_change(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.create_repo(Path(directory) / "repo")
            stage = self.create_repo(Path(directory) / "stage")
            deploy.ensure_existing_dependencies(stage, root)
            (stage / deploy.REQUIREMENTS[0]).write_text("changed dependency")
            with self.assertRaises(ValueError):
                deploy.ensure_existing_dependencies(stage, root)

    def test_secret_like_values_and_shell_injection_are_rejected(self):
        with self.assertRaises(ValueError):
            deploy.scan_secret(b"sk-proj-" + b"x" * 50)
        for value in ("abc;command", "a" * 39, "A" * 40):
            with self.assertRaises(ValueError):
                deploy.revision_value(value)

    def test_oidc_trust_matches_verified_immutable_main_subject(self):
        template = json.loads((Path(__file__).parent / "cicd.json").read_text())
        statement = template["Resources"]["DeployRole"]["Properties"]["AssumeRolePolicyDocument"]["Statement"][0]
        conditions = statement["Condition"]["StringEquals"]
        self.assertEqual(conditions["token.actions.githubusercontent.com:aud"], "sts.amazonaws.com")
        self.assertEqual(conditions["token.actions.githubusercontent.com:sub"],
                         "repo:cloud-project-mobility@341333303/make_drive_mate@1445282042:ref:refs/heads/main")

    def test_failed_health_restores_old_files_and_preserves_private_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.create_repo(Path(directory) / "root")
            version = root / ".releases" / "test"
            version.mkdir(parents=True)
            stage = self.create_repo(version / "staged")
            (stage / "code-release.json").write_text('{}')
            for relative in ("dist/index.html", "backend/scripts/document_rag.py", deploy.SINGLE_FILES[0]):
                (stage / relative).write_text("new code that fails health")
            with patch.object(deploy, "service") as service, patch.object(deploy.subprocess, "run"), \
                    patch.object(deploy, "healthy", side_effect=[False, True]):
                with self.assertRaisesRegex(RuntimeError, "previous API restored"):
                    deploy.activate_release(root, version, stage, "a" * 40, "b" * 64)
            self.assertEqual((root / "dist/index.html").read_text(), "synthetic test fixture")
            self.assertEqual((root / "backend/scripts/document_rag.py").read_text(), "synthetic test fixture")
            self.assertEqual((root / "backend/data/rag/private.json").read_text(), "never package private documents")
            self.assertEqual(json.loads((version / "deployment-state.json").read_text())["status"], "rolled_back")
            self.assertIn(unittest.mock.call("stop", "drivemate-cycle.service"), service.call_args_list)


if __name__ == "__main__":
    unittest.main()
