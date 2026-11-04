import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

import prepare_context
import runtime


def report():
    return {"schema_version": "drivemate-cycle-v1", "status": "completed", "production_promoted": False,
            "price_kind": "auction_award", "quality": {"clean_rows": 14867}, "model": {}, "charts": {}}


def pointer():
    return {"schema_version": "document-rag-v1", "collection_id": "synthetic-collection", "corpus_sha256": "a" * 64,
            "embedding_model": "text-embedding-3-small", "dimensions": 1536, "backend": "pgvector",
            "created_at": "2026-11-04T00:00:00Z", "document_count": 6, "chunk_count": 83,
            "index_relative_path": "collections/synthetic-collection.json",
            "storage": {"backend": "pgvector", "extension_version": "0.8.0", "stored_chunks": 83}}


def archive_bytes(extra=None):
    contents = {"model/model_bundle.joblib": b"synthetic-not-a-real-model", "model/metrics.json": b"{}",
                "backend/data/onbid/pipeline/latest.json": json.dumps(report()).encode(),
                "backend/scripts/onbid_worker.py": b"raise RuntimeError('must never be extracted')",
                "dist/index.html": b"must never replace baked web",
                "backend/data/onbid/seed-run/raw/page.json": b'{"items":[]}',
                "backend/data/rag/collections/private.json": b'{"vectors":[],"chunks":[]}'}
    contents.update(extra or {})
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as archive:
        for name, value in contents.items():
            archive.writestr(name, value)
    return stream.getvalue()


class FakeS3:
    def __init__(self, values):
        self.values = values
        self.keys = []

    def get_object(self, *, Bucket, Key):
        self.keys.append(Key)
        value = self.values[Key]
        return {"Body": io.BytesIO(value), "ContentLength": len(value)}

    def list_objects_v2(self, *, Bucket, Prefix, MaxKeys):
        self.listed = (Prefix, MaxKeys)
        return {"Contents": [{"Key": key} for key in sorted(self.values) if key.startswith(Prefix)][:MaxKeys]}


class RuntimeTest(unittest.TestCase):
    def test_proxy_replaces_alb_port_and_untrusted_forwarded_header(self):
        configuration = Path(__file__).with_name("nginx.conf").read_text()
        for location in ("location = /api/v1/location/stream {", "location /api/v1/ {"):
            with self.subTest(location=location):
                block = configuration.split(location, 1)[1].split("\n        }", 1)[0]
                self.assertIn("proxy_set_header X-Forwarded-Proto https;", block)
                self.assertIn("proxy_set_header X-Forwarded-Port 443;", block)
                self.assertIn('proxy_set_header Forwarded "";', block)
                self.assertIn("proxy_set_header X-Forwarded-Host $host;", block)

    def test_archive_code_and_private_corpus_never_replace_image_code(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = root / "release.zip"
            archive.write_bytes(archive_bytes())
            selected = runtime.extract_data(archive, root / "api", "api")
            self.assertEqual(set(selected), runtime.API_MEMBERS)
            self.assertFalse((root / "api/backend/scripts").exists())
            self.assertFalse((root / "api/backend/data/rag").exists())
            self.assertFalse((root / "api/backend/data/onbid/seed-run").exists())
            worker = runtime.extract_data(archive, root / "cycle", "cycle")
            self.assertIn("backend/data/onbid/seed-run/raw/page.json", worker)
            self.assertFalse((root / "cycle/dist").exists())

    def test_all_members_are_checked_even_when_not_selected(self):
        for unsafe in ("../escape.py", "/absolute.json", "code/../outside.py", "code\\escape.py", ".env.private"):
            with self.subTest(unsafe=unsafe), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                archive = root / "release.zip"
                archive.write_bytes(archive_bytes({unsafe: b"ignored"}))
                with self.assertRaises(ValueError):
                    runtime.extract_data(archive, root / "result", "api")

    def test_duplicate_and_symlink_archive_members_are_rejected(self):
        for symlink in (False, True):
            with self.subTest(symlink=symlink), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                archive = root / "release.zip"
                archive.write_bytes(archive_bytes())
                with zipfile.ZipFile(archive, 'a') as bundle:
                    if symlink:
                        item = zipfile.ZipInfo("code/link")
                        item.create_system = 3
                        item.external_attr = 0o120777 << 16
                        bundle.writestr(item, "/etc/passwd")
                    else:
                        with self.assertWarns(UserWarning):
                            bundle.writestr("dist/index.html", b"duplicate")
                with self.assertRaises(ValueError):
                    runtime.extract_data(archive, root / "result", "api")

    def test_verified_download_and_pointer_do_not_fetch_corpus(self):
        raw = archive_bytes()
        meta = json.dumps(pointer()).encode()
        client = FakeS3({"releases/data.zip": raw, "runtime/pointer.json": meta})
        environment = {"DRIVEMATE_RELEASE_BUCKET": "private-test-bucket", "DRIVEMATE_RELEASE_KEY": "releases/data.zip",
                       "DRIVEMATE_RELEASE_SHA256": hashlib.sha256(raw).hexdigest(), "DRIVEMATE_RAG_POINTER_KEY": "runtime/pointer.json",
                       "DRIVEMATE_RAG_POINTER_SHA256": hashlib.sha256(meta).hexdigest()}
        with tempfile.TemporaryDirectory() as folder:
            artifacts, hashes = runtime.prepare_artifacts(client, environment, Path(folder), "api")
            self.assertEqual(client.keys, ["releases/data.zip", "runtime/pointer.json"])
            self.assertEqual((artifacts / "backend/data/rag/active_collection.json").read_bytes(), meta)
            self.assertEqual(len(hashes), 3)

    def test_bad_release_or_pointer_checksum_fails_before_start(self):
        raw = archive_bytes()
        meta = json.dumps(pointer()).encode()
        for release_bad in (False, True):
            client = FakeS3({"release.zip": raw, "pointer.json": meta})
            environment = {"DRIVEMATE_RELEASE_BUCKET": "private-test-bucket", "DRIVEMATE_RELEASE_KEY": "release.zip",
                           "DRIVEMATE_RELEASE_SHA256": "0" * 64 if release_bad else hashlib.sha256(raw).hexdigest(),
                           "DRIVEMATE_RAG_POINTER_KEY": "pointer.json", "DRIVEMATE_RAG_POINTER_SHA256": "0" * 64}
            with self.subTest(release_bad=release_bad), tempfile.TemporaryDirectory() as folder:
                with self.assertRaises(ValueError):
                    runtime.prepare_artifacts(client, environment, Path(folder), "api")

    def test_pointer_has_metadata_only_and_reports_cannot_promote_a_model(self):
        self.assertEqual(runtime.validate_pointer(json.dumps(pointer()).encode())["chunk_count"], 83)
        for extra in ({"vectors": []}, {"chunks": []}, {"documents": []}, {"backend": "local"}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                runtime.validate_pointer(json.dumps({**pointer(), **extra}).encode())
        for extra in ({"production_promoted": True}, {"status": "running"}, {"price_kind": "retail_market"}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                runtime.validate_report(json.dumps({**report(), **extra}).encode())
        with self.assertRaises(ValueError):
            runtime.strict_json('{"key":1,"key":2}')
        with self.assertRaises(ValueError):
            runtime.strict_json('{"key":NaN}')

    def test_analytics_refresh_checks_exact_key_and_preserves_last_good_report(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "latest.json"
            original = json.dumps(report()).encode()
            target.write_bytes(original)
            client = FakeS3({"data/cycles/latest.json.other": b"not the report"})
            self.assertFalse(runtime.refresh_analytics(client, "private-test-bucket", "data/cycles/latest.json", target))
            self.assertEqual(client.listed, ("data/cycles/latest.json", 1))
            self.assertEqual(client.keys, [])
            self.assertEqual(target.read_bytes(), original)
            updated = {**report(), "quality": {"clean_rows": 42}}
            client.values["data/cycles/latest.json"] = json.dumps(updated).encode()
            self.assertTrue(runtime.refresh_analytics(client, "private-test-bucket", "data/cycles/latest.json", target))
            self.assertEqual(json.loads(target.read_bytes())["quality"]["clean_rows"], 42)
            client.values["data/cycles/latest.json"] = json.dumps({**report(), "production_promoted": True}).encode()
            with self.assertRaises(ValueError):
                runtime.refresh_analytics(client, "private-test-bucket", "data/cycles/latest.json", target)
            self.assertEqual(json.loads(target.read_bytes())["quality"]["clean_rows"], 42)

    def test_api_runtime_has_no_schema_bootstrap_or_master_credentials(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "artifacts/backend/data/onbid/pipeline/latest.json"
            source.parent.mkdir(parents=True)
            source.write_text(json.dumps(report()))
            environment = {"DRIVEMATE_DB_HOST": "private.example.test", "DRIVEMATE_DB_PASSWORD": "synthetic-db-password",
                           "OPENAI_API_KEY": "synthetic-openai-key", "DRIVEMATE_KNOWLEDGE_ALLOWED_EMAILS": "owner@example.test",
                           "ONBID_SERVICE_KEY": "not-for-api", "DRIVEMATE_KAKAO_REST_KEY": "synthetic-provider-key"}
            result = runtime.api_environment(environment, root, root / "artifacts", {"model/model_bundle.joblib": "a" * 64}, root / "runtime")
            self.assertEqual(result["SPRING_SQL_INIT_MODE"], "never")
            self.assertEqual(result["SPRING_DATASOURCE_USERNAME"], "drivemate_app")
            self.assertNotIn("ONBID_SERVICE_KEY", result)
            self.assertEqual(result["DRIVEMATE_KAKAO_REST_KEY"], environment["DRIVEMATE_KAKAO_REST_KEY"])
            for forbidden in ("DRIVEMATE_BOOTSTRAP_TOKEN", "DRIVEMATE_INITIAL_PASSWORD", "DB_SECRET_ARN"):
                with self.subTest(forbidden=forbidden), self.assertRaises(ValueError):
                    runtime.api_environment({**environment, forbidden: "blocked"}, root, root / "artifacts", {}, root / "runtime")

    def test_baked_web_copy_is_verified_and_uses_only_a_fresh_volume(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            app = root / "app"
            (app / "dist").mkdir(parents=True)
            (app / "dist/index.html").write_bytes(b"baked-static-web")
            manifest = {"file_sha256": {"app/dist/index.html": hashlib.sha256(b"baked-static-web").hexdigest()}}
            (app / "image-manifest.json").write_text(json.dumps(manifest))
            runtime.publish_web(app, root / "web")
            self.assertEqual((root / "web/site/index.html").read_bytes(), b"baked-static-web")
            with self.assertRaises(ValueError):
                runtime.publish_web(app, root / "web")
            (app / "dist/index.html").write_bytes(b"changed")
            with self.assertRaises(ValueError):
                runtime.publish_web(app, root / "other-web")

    def test_context_allowlist_excludes_private_inputs_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            repo = root / "repo"
            for name in (*prepare_context.REQUIRED, "dist/index.html", "backend/scripts/onbid_worker.py",
                         "infra/containers/Dockerfile", "infra/containers/.dockerignore",
                         *("infra/containers/" + name for name in prepare_context.CONTAINER_FILES)):
                target = repo / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("synthetic public code")
            for name in (".env.private", "backend/data/raw.json", "model/model_bundle.joblib"):
                target = repo / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("private sentinel never copied")
            result = prepare_context.prepare(repo, root / "context")
            self.assertFalse(result["private_runtime_data_included"])
            self.assertFalse((root / "context/app/backend/data").exists())
            self.assertFalse((root / "context/app/model").exists())
            self.assertNotIn("private sentinel", ''.join(p.read_text() for p in (root / "context").rglob('*') if p.is_file()))
            with self.assertRaises(ValueError):
                prepare_context.prepare(repo, root / "context")


if __name__ == "__main__":
    unittest.main()
