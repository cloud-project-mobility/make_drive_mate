import copy
import json
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import document_rag as rag


class DocumentRagTests(unittest.TestCase):
    def test_office_locations_do_not_invent_pages_and_slide_order_is_numeric(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.pptx"
            with zipfile.ZipFile(path, "w") as archive:
                for number in (10, 2):
                    archive.writestr(f"ppt/slides/slide{number}.xml", '<p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>내용' + str(number) + '</a:t></p>')
            result = rag.extract_office(path)
            self.assertEqual([item["location"] for item in result], ["슬라이드 2", "슬라이드 10"])
            path = Path(directory) / "sample.docx"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>검증된 문단 내용</w:t></w:r></w:p></w:body></w:document>')
            self.assertIn("문단", rag.extract_office(path)[0]["location"])
            self.assertNotIn("쪽", rag.extract_office(path)[0]["location"])

    def test_secrets_fail_closed_and_personal_information_redacted(self):
        for text in ("sk-proj-" + "a" * 40, "ONBID_SERVICE_KEY=" + "b" * 60,
                     "-----BEGIN PRIVATE KEY-----"):
            with self.assertRaises(ValueError):
                rag.secret_check(text)
        with self.assertRaises(ValueError):
            rag.secret_check("a private configured value", ["private configured value"])
        result = rag.redact_personal_data("김태오 hello@example.com 010-1234-5678 123가4567")
        self.assertNotIn("김태오", result)
        self.assertNotIn("@", result)
        self.assertNotIn("010-", result)
        self.assertNotIn("123가", result)

    def test_selection_cannot_introduce_claims_ids_or_unproven_answerability(self):
        sources = [{"source_id": "real"}]
        rag.validate_selection({"answerable": True, "source_ids": ["real"]}, sources)
        for value in ({"answerable": True, "source_ids": ["invented"]},
                      {"answerable": False, "source_ids": ["real"]},
                      {"answerable": True, "source_ids": [], "price": 100},
                      {"answerable": True, "source_ids": ["real", "real"]}):
            with self.assertRaises(ValueError):
                rag.validate_selection(value, sources)

    def test_request_rejects_injected_paths_credentials_and_duplicate_keys(self):
        for value in ({"question": "질문", "api_key": "other"}, {"question": "x" * 1001},
                      {"question": "hello", "use_llm": 1}, {"question": "\x00"}):
            with self.assertRaises(ValueError):
                rag.validate_request(value)
        with self.assertRaises(ValueError):
            json.loads('{"question":"a","question":"b"}', object_pairs_hook=rag.duplicate_guard)

    def test_bm25_korean_bigrams_and_rrf(self):
        chunks = [{"source_id": "a", "quote": "자동차의 낙찰가격과 공매결과"},
                  {"source_id": "b", "quote": "음악 공연 일정"}]
        self.assertEqual(rag.bm25_ranking("공매 낙찰가", chunks)[0][0], "a")
        self.assertEqual(rag.reciprocal_rank_fusion([[('a', 1), ('b', .5)], [('a', .9)]])[0], "a")

    def test_vectors_and_corpus_hash_are_validated_before_import(self):
        corpus = {"documents": [], "chunks": [{"source_id": "a", "quote": "safe"}]}
        sha = rag.digest(rag.canonical(corpus).encode())
        index = {**corpus, "corpus_sha256": sha, "collection_id": "rag-" + sha[:20],
                 "embedding_model": rag.EMBEDDING_MODEL, "dimensions": 1536, "vectors": [[1.] + [0.] * 1535]}
        rag.validate_index(index)
        altered = copy.deepcopy(index)
        altered["chunks"][0]["quote"] = "altered"
        with self.assertRaises(ValueError):
            rag.validate_index(altered)
        index["vectors"][0][0] = float("nan")
        with self.assertRaises(ValueError):
            rag.validate_index(index)

    def test_unanswerable_retrieval_does_not_call_llm(self):
        with patch.object(rag, "embed", return_value=([[1.] * 1536], {})), \
             patch.object(rag, "retrieve", return_value=([], {"evidence_gate_passed": False})), \
             patch.object(rag, "select_sources") as selector:
            result = rag.query("문서 밖 질문", {}, {"api_key": "test"}, use_llm=True)
            self.assertEqual(result["status"], "abstained")
            selector.assert_not_called()

    def test_model_failure_is_retrieval_only_and_does_not_invent_answer(self):
        source = {"source_id": "real", "quote": "original"}
        with patch.object(rag, "embed", return_value=([[1.] * 1536], {})), \
             patch.object(rag, "retrieve", return_value=([source], {"evidence_gate_passed": True})), \
             patch.object(rag, "select_sources", side_effect=RuntimeError("provider private details")):
            result = rag.query("question", {}, {"api_key": "test"}, use_llm=True)
            self.assertEqual(result["status"], "retrieval_only")
            self.assertEqual(result["answer_source_ids"], [])
            self.assertNotIn("private", rag.canonical(result))

    def test_production_query_reads_environment_without_an_env_file(self):
        with tempfile.TemporaryDirectory() as directory:
            pointer = Path(directory) / "active_collection.json"
            pointer.write_text(json.dumps({"backend": "pgvector", "embedding_model": rag.EMBEDDING_MODEL}))
            with patch.dict(os.environ, {"OPENAI_API_KEY": "test-configured-key"}), \
                    patch.object(rag.sys, "stdin") as stdin, patch.object(rag.sys, "stdout", io.StringIO()), \
                    patch.object(rag, "query", return_value={"status": "retrieval_only"}) as query:
                stdin.buffer = io.BytesIO(b'{"question":"test question"}')
                status = rag.main(["query", "--repo-root", directory, "--collection-file", str(pointer)])
                self.assertEqual(status, 0)
                self.assertEqual(query.call_args.args[2]["api_key"], "test-configured-key")


if __name__ == "__main__":
    unittest.main()
