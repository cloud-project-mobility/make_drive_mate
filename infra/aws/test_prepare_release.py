import contextlib
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import prepare_release as release


class PrivateReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.source = self.directory / 'canonical'
        self.private = self.directory / 'private'
        self.output = self.directory / 'output'
        for name in release.CODE_FILES:
            self.write(self.source / name, 'canonical-code')
        self.jar = self.source / release.CODE_FILES[0]
        with zipfile.ZipFile(self.jar, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('BOOT-INF/classes/version.txt', 'canonical-version')
        self.write(self.source / 'backend/scripts/onbid_model.py', 'canonical-model-code')
        self.write(self.source / 'backend/scripts/test_private.py', 'must not package test')
        self.write(self.private / '.env.onbid.local', 'ONBID_SERVICE_KEY=toy-onbid-private-value\nOPTIONAL=\n')
        self.write(self.private / '.env.llm.local', 'OPENAI_API_KEY="toy-openai-local-value"\nOPENAI_MODEL=toy-model\n')
        self.secret = self.private / 'backend/data/deployment/app-secret.json'
        self.secret_values = {'OPENAI_API_KEY': 'toy-openai-existing-secret-value',
                              'DRIVEMATE_DB_PASSWORD': 'toy-existing-db-password',
                              'DRIVEMATE_INITIAL_PASSWORD': 'toy-existing-owner-password',
                              'DRIVEMATE_INITIAL_EMAIL': 'owner@example.test'}
        self.write(self.secret, json.dumps(self.secret_values))
        self.write(self.private / release.DEFAULT_MODEL / 'model_bundle.joblib', 'approved-model')
        self.write(self.private / release.DEFAULT_MODEL / 'metrics.json', '{"mae": 1}')
        self.write(self.private / release.DEFAULT_RUN / 'raw/rows.json', '[{"synthetic":true}]')
        self.write(self.private / release.DEFAULT_REPORT, '{"status":"completed"}')
        self.rag(self.private / release.DEFAULT_RAG, 'approved')

    def write(self, path, content):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding='utf-8')

    def rag(self, directory, identifier):
        self.write(directory / 'local_collection.json', json.dumps({
            'collection_id': identifier, 'index_relative_path': 'collections/' + identifier + '.json'}))
        self.write(directory / 'collections' / (identifier + '.json'), json.dumps({'synthetic': identifier}))
        self.write(directory / 'snapshots/unneeded.json', 'private snapshot not needed at runtime')

    def package(self, **kwargs):
        return release.package(self.source, self.private, self.output, **kwargs)

    def test_package_uses_canonical_code_without_modifying_or_copying_credentials(self):
        self.write(self.private / 'dist/index.html', 'stale-private-code')
        before = self.secret.read_bytes()
        result = self.package()
        self.assertEqual(self.secret.read_bytes(), before)
        self.assertEqual(result['secret_scan'], 'passed')
        self.assertEqual(result['sha256'], hashlib.sha256((self.output / 'release.zip').read_bytes()).hexdigest())
        with zipfile.ZipFile(self.output / 'release.zip') as archive:
            self.assertEqual(archive.read('dist/index.html'), b'canonical-code')
            self.assertEqual(archive.read('model/model_bundle.joblib'), b'approved-model')
            self.assertIn('backend/data/onbid/seed-run/raw/rows.json', archive.namelist())
            self.assertIn('backend/data/rag/collections/approved.json', archive.namelist())
            self.assertFalse(any('.env' in name or 'app-secret' in name or 'snapshots/' in name
                                 or 'test_private' in name for name in archive.namelist()))
        manifest = json.loads((self.output / 'release-manifest.json').read_text())
        self.assertEqual(set(manifest['file_sha256']), set(manifest['members']))

    def test_normal_cli_never_calls_secret_generation_or_displays_values(self):
        self.secret.unlink()
        output = io.StringIO()
        with patch.object(release, 'ROOT', self.source), patch.object(release, 'prepare_secret') as create, \
                contextlib.redirect_stdout(output):
            release.main(['--private-root', str(self.private), '--output-dir', str(self.output)])
        create.assert_not_called()
        self.assertFalse(self.secret.exists())
        self.assertNotIn('toy-openai-local-value', output.getvalue())
        self.assertNotIn('toy-onbid-private-value', output.getvalue())
        self.assertEqual(json.loads(output.getvalue())['secret_scan'], 'passed')

    def test_explicit_new_artifact_selection_is_recorded_and_packaged(self):
        self.write(self.private / 'new-model/model_bundle.joblib', 'reviewed-new-model')
        self.write(self.private / 'new-model/metrics.json', '{"mae":2}')
        self.write(self.private / 'new-run/rows.csv', 'synthetic,new')
        self.write(self.private / 'new-latest.json', '{"run_id":"new"}')
        self.rag(self.private / 'new-rag', 'new')
        self.package(model_dir=Path('new-model'), raw_run_dir=self.private / 'new-run',
                     analytics_report=Path('new-latest.json'), rag_dir=Path('new-rag'))
        with zipfile.ZipFile(self.output / 'release.zip') as archive:
            self.assertEqual(archive.read('model/model_bundle.joblib'), b'reviewed-new-model')
            self.assertEqual(archive.read('backend/data/onbid/pipeline/latest.json'), b'{"run_id":"new"}')
            self.assertIn('backend/data/onbid/seed-run/rows.csv', archive.namelist())
            self.assertNotIn('backend/data/rag/collections/approved.json', archive.namelist())
        manifest = json.loads((self.output / 'release-manifest.json').read_text())
        self.assertEqual(manifest['inputs']['model_dir'], str(self.private / 'new-model'))

    def test_missing_selected_artifact_fails_before_creating_output(self):
        (self.private / release.DEFAULT_MODEL / 'model_bundle.joblib').unlink()
        with self.assertRaisesRegex(ValueError, 'Required release artifact absent'):
            self.package()
        self.assertFalse(self.output.exists())

    def test_output_reuse_is_rejected_without_overwriting_previous_release(self):
        self.package()
        before = (self.output / 'release.zip').read_bytes()
        with self.assertRaisesRegex(ValueError, 'already exists'):
            self.package()
        self.assertEqual((self.output / 'release.zip').read_bytes(), before)

    def test_default_output_is_unique(self):
        first = release.package(self.source, self.private)
        second = release.package(self.source, self.private)
        self.assertNotEqual(first['output_dir'], second['output_dir'])
        self.assertTrue(Path(first['output_dir'], 'release.zip').is_file())

    def test_scan_checks_local_keys_and_existing_secret_without_printing_values(self):
        for secret in ('toy-openai-local-value', 'toy-openai-existing-secret-value', 'toy-existing-db-password'):
            with self.subTest(secret_source=secret.split('-')[1]):
                self.write(self.source / 'dist/index.html', secret)
                with self.assertRaisesRegex(ValueError, 'Secret found') as error:
                    self.package()
                self.assertNotIn(secret, str(error.exception))
                self.assertFalse(self.output.exists())

    def test_scan_checks_compressed_jar_members(self):
        with zipfile.ZipFile(self.jar, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('BOOT-INF/classes/private.txt', 'toy-onbid-private-value')
        with self.assertRaisesRegex(ValueError, 'Secret found'):
            self.package()
        self.assertFalse(self.output.exists())

    def test_optional_provider_keys_and_client_credentials_are_scanned_without_copying(self):
        values = {
            '.env.kakao.local': {'KAKAO_REST_API_KEY': 'toy-kakao-rest-private',
                                 'KAKAO_ADMIN_KEY': 'toy-kakao-admin-private',
                                 'KAKAO_JAVASCRIPT_KEY': 'toy-kakao-js-private'},
            '.env.hyundai.local': {'HYUNDAI_CLIENT_ID': 'toy-hyundai-client-id',
                                   'HYUNDAI_CLIENT_SECRET': 'toy-hyundai-client-secret'},
        }
        for filename, entries in values.items():
            self.write(self.private / filename, ''.join(key + '=' + value + '\n' for key, value in entries.items()))
        originals = {name: (self.private / name).read_bytes() for name in values}
        for entries in values.values():
            for key, value in entries.items():
                with self.subTest(key=key):
                    self.write(self.source / 'dist/index.html', value)
                    with self.assertRaisesRegex(ValueError, 'Secret found') as error:
                        self.package()
                    self.assertNotIn(value, str(error.exception))
                    self.assertFalse(self.output.exists())
        self.write(self.source / 'dist/index.html', 'canonical-code')
        self.package()
        with zipfile.ZipFile(self.output / 'release.zip') as archive:
            self.assertFalse(any('.env' in name for name in archive.namelist()))
        for name, content in originals.items():
            self.assertEqual((self.private / name).read_bytes(), content)

    def test_symlinks_and_escaping_rag_pointer_are_rejected(self):
        link = self.private / release.DEFAULT_RUN / 'linked.json'
        link.symlink_to(self.secret)
        with self.assertRaisesRegex(ValueError, 'symlinks'):
            self.package()
        link.unlink()
        self.write(self.private / release.DEFAULT_RAG / 'local_collection.json',
                   '{"index_relative_path":"../private.json"}')
        with self.assertRaisesRegex(ValueError, 'pointer is invalid'):
            self.package()
        self.assertFalse(self.output.exists())

    def test_public_map_key_requires_opt_in_and_only_web_javascript_is_allowed(self):
        public_key = 'toy-kakao-public-javascript-key'
        self.write(self.private / '.env.kakao.local', 'DRIVEMATE_KAKAO_JAVASCRIPT_KEY=' + public_key)
        javascript = self.source / 'dist/_expo/static/js/web/entry-test.js'
        self.write(javascript, public_key)
        with self.assertRaisesRegex(ValueError, 'Secret found'):
            self.package()
        self.package(public_kakao_map=True)
        manifest = json.loads((self.output / 'release-manifest.json').read_text())
        self.assertTrue(manifest['public_kakao_map'])
        self.output = self.directory / 'second-output'
        self.write(self.source / 'dist/index.html', public_key)
        with self.assertRaisesRegex(ValueError, 'Secret found'):
            self.package(public_kakao_map=True)

    def test_public_map_mode_never_allows_private_keys_or_overlapping_values(self):
        public_key = 'toy-kakao-public-javascript-key'
        self.write(self.private / '.env.kakao.local', 'DRIVEMATE_KAKAO_JAVASCRIPT_KEY=' + public_key)
        self.write(self.source / 'dist/_expo/static/js/web/entry-test.js', public_key + ' toy-onbid-private-value')
        with self.assertRaisesRegex(ValueError, 'Secret found'):
            self.package(public_kakao_map=True)
        self.write(self.private / '.env.kakao.local', 'DRIVEMATE_KAKAO_JAVASCRIPT_KEY=toy-onbid-private-value')
        with self.assertRaisesRegex(ValueError, 'overlaps'):
            self.package(public_kakao_map=True)

    def test_credential_changes_require_explicit_mode_and_private_root_is_required(self):
        for arguments in ([], ['--private-root', str(self.private), '--owner-email', 'owner@example.test']):
            with self.subTest(arguments=arguments), patch.object(release, 'prepare_secret') as create, \
                    contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                release.main(arguments)
            create.assert_not_called()
        with patch.object(release, 'prepare_secret') as create, contextlib.redirect_stdout(io.StringIO()):
            release.main(['--private-root', str(self.private), '--secrets-only'])
        create.assert_called_once_with(None, False, self.private)


if __name__ == '__main__':
    unittest.main()
