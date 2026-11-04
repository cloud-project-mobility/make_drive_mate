"""Synthetic checks only; never read deployment credentials or contact the service."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import setup_owner_password as setup


EMAIL = "owner@example.test"
INITIAL = "synthetic-initial-password"
NEXT = "synthetic-new-password"


class FakeClient:
    def __init__(self, failure=None):
        self.failure = failure
        self.calls = []
        self.logins = 0

    def verify(self):
        return None

    def request(self, path, method="GET", token=None, body=None):
        self.calls.append((path, method, token, body))
        if path == "/auth/login":
            self.logins += 1
            if self.failure == "new_login" and self.logins == 2:
                raise setup.SetupError("request_failed")
            return {"access_token": ("a" if self.logins == 1 else "b") * 43,
                    "token_type": "bearer", "user": {"id": "synthetic-account", "email": EMAIL}}
        if path == "/auth/password":
            if self.failure == "change":
                raise setup.SetupError("request_failed")
            return {"ok": True, "reauthentication_required": True}
        if path == "/auth/logout":
            return {"ok": self.failure != "cleanup"}
        raise AssertionError("unexpected synthetic request")


class SetupOwnerPasswordTest(unittest.TestCase):
    def test_rotation_verifies_new_login_and_revokes_both_transient_sessions(self):
        client = FakeClient()
        setup.rotate_password(client, EMAIL, INITIAL, NEXT)
        self.assertEqual([call[0] for call in client.calls], [
            "/auth/login", "/auth/password", "/auth/login", "/auth/logout", "/auth/logout"])
        self.assertEqual(client.calls[1][3], {"current_password": INITIAL, "new_password": NEXT})
        self.assertEqual(client.calls[-2][2], "a" * 43)
        self.assertEqual(client.calls[-1][2], "b" * 43)

    def test_failure_after_rotation_keeps_changed_status_and_cleans_up(self):
        client = FakeClient("new_login")
        with self.assertRaises(setup.SetupError) as caught:
            setup.rotate_password(client, EMAIL, INITIAL, NEXT)
        self.assertEqual(caught.exception.code, "new_login_unverified")
        self.assertTrue(caught.exception.changed)
        self.assertEqual(client.calls[-1][0], "/auth/logout")

    def test_uncertain_change_is_never_automatically_retried(self):
        client = FakeClient("change")
        with self.assertRaises(setup.SetupError) as caught:
            setup.rotate_password(client, EMAIL, INITIAL, NEXT)
        self.assertEqual(caught.exception.code, "change_uncertain")
        self.assertEqual(sum(call[0] == "/auth/password" for call in client.calls), 1)
        self.assertEqual(client.calls[-1][0], "/auth/logout")

    def test_failed_cleanup_is_not_reported_as_success(self):
        with self.assertRaises(setup.SetupError) as caught:
            setup.rotate_password(FakeClient("cleanup"), EMAIL, INITIAL, NEXT)
        self.assertEqual(caught.exception.code, "cleanup_unverified")
        self.assertTrue(caught.exception.changed)

    def test_masked_password_confirmation_and_utf16_length_match_server(self):
        with patch.object(setup.getpass, "getpass", side_effect=[NEXT, NEXT]) as prompt:
            self.assertEqual(setup.read_new_password(), NEXT)
            self.assertEqual(prompt.call_count, 2)
        with patch.object(setup.getpass, "getpass", side_effect=[NEXT, INITIAL]):
            with self.assertRaisesRegex(setup.SetupError, "password_mismatch"):
                setup.read_new_password()
        oversized = "\U0001f698" * 65
        with patch.object(setup.getpass, "getpass", side_effect=[oversized, oversized]):
            with self.assertRaisesRegex(setup.SetupError, "password_invalid"):
                setup.read_new_password()

    def test_noninteractive_execution_stops_before_network_or_credential_read(self):
        error = io.StringIO()
        with patch.object(setup.sys.stdin, "isatty", return_value=False), \
                patch.object(setup, "ApiClient") as client, \
                patch.object(setup, "load_initial_credentials") as reader, contextlib.redirect_stderr(error):
            self.assertEqual(setup.main([]), 1)
        client.assert_not_called()
        reader.assert_not_called()
        self.assertNotIn(INITIAL, error.getvalue())

    def test_main_does_not_echo_secrets_or_modify_initial_file(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "synthetic.json"
            content = json.dumps({"DRIVEMATE_INITIAL_EMAIL": EMAIL, "DRIVEMATE_INITIAL_PASSWORD": INITIAL,
                                  "unrelated_secret": "synthetic-unrelated-value"})
            source.write_text(content, encoding="utf-8")
            output = io.StringIO()
            with patch.object(setup.sys.stdin, "isatty", return_value=True), \
                    patch.object(setup.sys.stderr, "isatty", return_value=True), \
                    patch.object(setup, "ApiClient", return_value=FakeClient()), \
                    patch.object(setup, "read_new_password", return_value=NEXT), \
                    contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                # redirect_stderr replaces the stream; keep its synthetic isatty true.
                with patch.object(output, "isatty", return_value=True):
                    self.assertEqual(setup.main(["--initial-config", str(source)]), 0)
            self.assertEqual(source.read_text(encoding="utf-8"), content)
            for private in [INITIAL, NEXT, EMAIL, "a" * 43, "b" * 43, "synthetic-unrelated-value"]:
                self.assertNotIn(private, output.getvalue())
            self.assertIn("초기설정용 비밀번호는 이제 무효", output.getvalue())

    def test_private_dns_and_redirects_are_rejected(self):
        with patch.dict(setup.os.environ, {}, clear=True):
            client = setup.ApiClient()
        with patch.object(setup.socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("127.0.0.1", 443))]), \
                patch.object(client, "request") as request:
            with self.assertRaisesRegex(setup.SetupError, "endpoint_unverified"):
                client.verify()
            request.assert_not_called()
        with self.assertRaisesRegex(setup.SetupError, "request_failed"):
            setup.NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://example.test")

    def test_tls_key_logging_is_rejected_before_client_creation(self):
        with patch.dict(setup.os.environ, {"SSLKEYLOGFILE": "/synthetic/not-written.log"}):
            with self.assertRaisesRegex(setup.SetupError, "diagnostics_enabled"):
                setup.ApiClient()


if __name__ == "__main__":
    unittest.main()
