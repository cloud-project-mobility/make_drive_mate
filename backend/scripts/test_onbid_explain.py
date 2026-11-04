"""Contract tests for grounded descriptions; no external service is called."""

import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import Mock, patch

from onbid_explain import _response_text, explain, load_openai_config, openai_selector


class ExplanationTest(unittest.TestCase):
    def setUp(self):
        self.facts = [
            {"id": "price", "kind": "evidence", "statement": "예상 낙찰가 500만원."},
            {"id": "scope", "kind": "caution", "statement": "소비자 시세가 아님.",
             "required": True},
        ]

    def test_no_provider_is_explicit_template(self):
        result = explain(self.facts)
        self.assertEqual(result["mode"], "template")
        self.assertEqual(result["fallback_reason"], "LLM_NOT_CONFIGURED")

    def test_unknown_claim_is_rejected(self):
        result = explain(self.facts, lambda _: {
            "overview_ids": ["invented_price"], "caution_ids": [],
            "next_action": "GET_REAL_QUOTE"})
        self.assertEqual(result["fallback_reason"], "LLM_CALL_OR_VALIDATION_FAILED")
        self.assertNotIn("invented_price", result["text"])

    def test_mandatory_limit_cannot_be_suppressed(self):
        result = explain(self.facts, lambda _: {
            "overview_ids": ["price"], "caution_ids": [], "next_action": "COMPARE_SCENARIOS"})
        self.assertEqual(result["mode"], "llm_selected_verified_facts")
        self.assertIn("소비자 시세가 아님", result["text"])

    def test_free_text_price_is_not_accepted(self):
        result = explain(self.facts, lambda _: {
            "overview_ids": ["price"], "caution_ids": [], "next_action": "GET_REAL_QUOTE",
            "summary": "가격은 9999만원입니다."})
        self.assertEqual(result["mode"], "template")
        self.assertNotIn("9999", result["text"])

    def test_openai_request_uses_bearer_and_strict_response_schema(self):
        selection = {"overview_ids": ["price"], "caution_ids": ["scope"],
                     "next_action": "GET_REAL_QUOTE"}
        response = {"status": "completed", "model": "fixture-model", "usage": {"total_tokens": 25},
                    "output": [{"type": "message", "role": "assistant", "content": [
                        {"type": "output_text", "text": json.dumps(selection)}]}]}
        opener = Mock()
        opener.open.return_value = io.BytesIO(json.dumps(response).encode())
        with patch("onbid_explain.urllib.request.build_opener", return_value=opener):
            selector = openai_selector("fixture-not-a-real-key")
            opener.open.assert_not_called()
            result = explain(self.facts, selector)
        self.assertEqual(result["mode"], "llm_selected_verified_facts")
        request = opener.open.call_args.args[0]
        body = json.loads(request.data)
        self.assertEqual(request.full_url, "https://api.openai.com/v1/responses")
        self.assertEqual(request.get_header("Authorization"), "Bearer fixture-not-a-real-key")
        self.assertNotIn("fixture-not-a-real-key", request.data.decode())
        self.assertTrue(body["text"]["format"]["strict"])
        self.assertFalse(body["store"])
        self.assertEqual(selector.last_call["usage"]["total_tokens"], 25)

    def test_openai_incomplete_and_refusal_are_not_used(self):
        for payload in [
            {"status": "incomplete", "output": []},
            {"status": "completed", "output": [{"type": "message", "role": "assistant",
                "content": [{"type": "refusal", "refusal": "fixture refusal"}]}]},
        ]:
            with self.assertRaises(RuntimeError):
                _response_text(payload)

    def test_openai_http_error_does_not_reveal_provider_message(self):
        opener = Mock()
        error_body = io.BytesIO(json.dumps({"error": {"code": "invalid_api_key",
            "message": "Secret fixture-not-a-real-key must not be displayed"}}).encode())
        opener.open.side_effect = urllib.error.HTTPError(
            "https://api.openai.com/v1/responses", 401, "Unauthorized", {}, error_body)
        with patch("onbid_explain.urllib.request.build_opener", return_value=opener):
            selector = openai_selector("fixture-not-a-real-key")
            with self.assertRaisesRegex(RuntimeError, "^OpenAI HTTP 401: invalid_api_key$"):
                selector("fixture prompt")
        self.assertNotIn("fixture-not-a-real-key", json.dumps(selector.last_call))

    def test_openai_env_file_loading_and_environment_precedence(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env.llm.local"
            path.write_text('OPENAI_API_KEY="fixture-file-key"\nOPENAI_MODEL=fixture-model\n')
            with patch.dict("os.environ", {}, clear=True):
                config = load_openai_config(path)
                self.assertEqual(config["api_key"], "fixture-file-key")
                self.assertEqual(config["model"], "fixture-model")
            with patch.dict("os.environ", {"OPENAI_API_KEY": "fixture-env-key"}, clear=True):
                self.assertEqual(load_openai_config(path)["api_key"], "fixture-env-key")


if __name__ == "__main__":
    unittest.main()
