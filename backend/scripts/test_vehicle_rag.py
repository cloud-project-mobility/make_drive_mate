import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import document_rag as documents
import vehicle_rag as rag


def fixture():
    scope = {"scope": "model_specific", "make": "현대", "model": "아반떼",
             "year_from": 2023, "year_to": 2023, "fuel_types": ["휘발유", "LPG"]}
    document = {"document_id": "manual", "title": "공식 사용설명서 기반 요약",
                "source_uri": "https://ownersmanual.hyundai.com/manual.pdf#page=12",
                "audience": "public_vehicle", "content_kind": "narrative",
                "source_kind": "official_manual_summary", "applicability": scope}
    chunk = {"source_id": "manual-tires", "document_id": "manual", "document_title": document["title"],
             "source_uri": document["source_uri"], "parent_id": "manual:tires", "section": "타이어 점검",
             "page": 12, "quote": "타이어 점검은 외관의 손상과 마모를 살피고 이상이 있으면 점검을 받도록 안내합니다.",
             "audience": "public_vehicle", "content_kind": "narrative",
             "source_kind": "official_manual_summary", "applicability": copy.deepcopy(scope)}
    index = {"schema_version": rag.SCHEMA_VERSION, "purpose": rag.PURPOSE,
             "embedding_model": documents.EMBEDDING_MODEL, "dimensions": documents.DIMENSIONS,
             "documents": [document], "chunks": [chunk], "vectors": [[1.0] + [0.0] * 1535]}
    seal(index)
    return index


def seal(index):
    index["corpus_sha256"] = hashlib.sha256(documents.canonical({
        "documents": index["documents"], "chunks": index["chunks"]}).encode()).hexdigest()
    index["collection_id"] = "rag-" + index["corpus_sha256"][:20]


def pointer(index):
    return {**{key: index[key] for key in ("schema_version", "purpose", "collection_id", "corpus_sha256", "embedding_model", "dimensions")},
            "document_count": len(index["documents"]), "chunk_count": len(index["chunks"])}


def identity(**updates):
    return {"make": "현대", "model": "아반떼", "model_year": 2023, "fuel": "휘발유", **updates}


class VehicleRagTests(unittest.TestCase):
    def setUp(self):
        self.network = patch("urllib.request.OpenerDirector.open", side_effect=AssertionError("No network"))
        self.network.start()
        self.addCleanup(self.network.stop)

    def test_private_collection_and_mixed_or_tabular_sources_are_rejected(self):
        index = fixture()
        for mutation in (lambda x: x.update(purpose="private_project"),
                         lambda x: x["chunks"][0].update(audience="private_project"),
                         lambda x: x["documents"][0].update(content_kind="price_table"),
                         lambda x: x["chunks"][0].update(source_kind="verbatim_quote")):
            changed = copy.deepcopy(index)
            mutation(changed)
            seal(changed)
            with self.assertRaises(ValueError):
                rag.validate_public_index(changed)
        with self.assertRaises(ValueError):
            rag.validate_pointer({**pointer(index), "schema_version": "document-rag-v1"})

    def test_source_provenance_urls_and_scope_must_match(self):
        for update in ({"source_uri": "https://example.com/private"}, {"document_title": "different"},
                       {"page": True}, {"source_id": "../private"}, {"page": 0}):
            index = fixture()
            index["chunks"][0].update(update)
            seal(index)
            with self.assertRaises(ValueError):
                rag.validate_public_index(index)
        for url in ("http://ownersmanual.hyundai.com/", "https://ownersmanual.hyundai.com.evil.test/",
                    "https://user@ownersmanual.hyundai.com/", "https://ownersmanual.kia.com:8443/"):
            with self.assertRaises(ValueError):
                rag.official_url(url)

    def test_identity_accepts_only_known_nullable_fields_and_integer_year(self):
        for value in (None, identity(), identity(make=None, model=None, fuel=None, model_year=None)):
            self.assertEqual(rag.validate_identity(value), value)
        for value in (identity(model_year=True), identity(model_year=2023.0), identity(model_year=1900),
                      identity(make="\n현대"), {**identity(), "collection": "private"}):
            with self.assertRaises(ValueError):
                rag.validate_identity(value)

    def test_applicability_filters_before_embedding_and_never_guesses_fuel(self):
        index = fixture()
        embed = Mock(side_effect=AssertionError("Not eligible"))
        for vehicle, status in ((identity(model="K5"), "no_match"), (identity(model_year=2024), "no_match"),
                                (identity(model="K5", fuel=None), "no_match"),
                                (identity(fuel="ICE"), "no_match"), (identity(fuel=None), "needs_vehicle_details"),
                                (None, "needs_vehicle_details")):
            result = rag.retrieve("타이어 점검", vehicle, pointer(index), "local", "", index, embed)
            self.assertEqual(result["status"], status)
            self.assertEqual(result["sources"], [])
        embed.assert_not_called()
        self.assertTrue(rag.applies(index["documents"][0]["applicability"], identity(make="현대자동차", fuel="가솔린")))
        self.assertEqual(rag.canonical_fuel("ICE"), "ice")
        self.assertEqual(rag.canonical_fuel("HEV"), "하이브리드")

    def test_matching_summary_retains_official_provenance_and_unknown_question_is_empty(self):
        index = fixture()
        embed = Mock(return_value=index["vectors"][0])
        result = rag.retrieve("타이어 점검", identity(), pointer(index), "local", "", index, embed)
        self.assertEqual(result["status"], "matched")
        self.assertEqual(result["sources"][0], rag.source_view(index["chunks"][0]))
        self.assertEqual(result["answer_source_ids"], [])  # Selection is the assistant's next stage.
        result = rag.retrieve("보험료 할인", identity(), pointer(index), "local", "", index, embed)
        self.assertEqual(result["status"], "no_match")
        self.assertEqual(embed.call_count, 1)
        self.assertEqual(rag.rank_sources("타이어 점검", index["chunks"], [("manual-tires", .29)]), [])

    def test_general_guidance_does_not_invent_vehicle_specific_scope(self):
        index = fixture()
        scope = {"scope": "general", "make": None, "model": None, "year_from": None, "year_to": None, "fuel_types": []}
        index["documents"][0]["applicability"] = scope
        index["chunks"][0]["applicability"] = copy.deepcopy(scope)
        seal(index)
        result = rag.retrieve("타이어 점검", None, pointer(index), "local", "", index, lambda _: index["vectors"][0])
        self.assertEqual(result["status"], "matched")
        self.assertEqual(result["sources"][0]["applicability"], scope)

    def test_pointer_checksum_path_and_counts_fail_closed(self):
        index = fixture()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "pointer.json"
            body = {**pointer(index), "index_relative_path": "../private.json"}
            path.write_text(json.dumps(body))
            sha = hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertEqual(rag.retrieve_for_assistant("타이어", identity(), path, sha, "local", "")["status"], "unavailable")
            self.assertEqual(rag.retrieve_for_assistant("타이어", identity(), path, "0" * 64, "pgvector", "")["status"], "unavailable")
        with self.assertRaises(ValueError):
            rag.retrieve("타이어", identity(), {**pointer(index), "chunk_count": 2}, "local", "", index)

    def test_pgvector_queries_are_bound_to_validated_public_collection_and_eligible_ids(self):
        index = fixture()
        connection = Mock()
        connection.execute.side_effect = [Mock(), Mock(fetchone=lambda: (index["corpus_sha256"], documents.EMBEDDING_MODEL, 1536)),
            Mock(fetchall=lambda: [(index["chunks"][0], index["documents"][0])]), Mock(fetchall=lambda: [("manual-tires", .8)])]
        with (patch.object(documents, "pg_connect", return_value=connection),
              patch.object(documents, "bm25_ranking", wraps=documents.bm25_ranking) as lexical,
              patch.object(documents, "vector_literal", wraps=documents.vector_literal) as serialize):
            result = rag.retrieve("타이어 점검", identity(), pointer(index), "pgvector", "", embedder=lambda _: index["vectors"][0])
        lexical.assert_called_once()
        serialize.assert_called_once_with(index["vectors"][0])
        self.assertEqual(result["status"], "matched")
        sql, args = connection.execute.call_args.args
        self.assertIn("collection_id=%s AND source_id=ANY(%s)", sql)
        self.assertNotIn(index["collection_id"], sql)
        self.assertEqual(args[1:3], (index["collection_id"], ["manual-tires"]))
        connection.close.assert_called_once()

    def test_private_database_row_is_rejected_before_embedding(self):
        index = fixture()
        chunk = {**index["chunks"][0], "audience": "private_project"}
        connection = Mock()
        connection.execute.side_effect = [Mock(), Mock(fetchone=lambda: (index["corpus_sha256"], documents.EMBEDDING_MODEL, 1536)),
            Mock(fetchall=lambda: [(chunk, index["documents"][0])])]
        embed = Mock()
        with patch.object(documents, "pg_connect", return_value=connection), self.assertRaises(ValueError):
            rag.retrieve("타이어", identity(), pointer(index), "pgvector", "", embedder=embed)
        embed.assert_not_called()
        connection.close.assert_called_once()

    def test_prepared_import_is_validated_and_does_not_embed(self):
        index = fixture()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "prepared.json"
            path.write_text(documents.canonical(index))
            with patch.object(documents, "store_pgvector", return_value={"backend": "pgvector"}) as store, patch.object(documents, "embed", side_effect=AssertionError("No paid call")):
                result = rag.build(path, Path(directory) / "out", "pgvector")
                self.assertFalse(result["external_embedding_called"])
                saved = rag.load_pointer(Path(directory) / "out/active_collection.json", result["pointer_sha256"])
                self.assertEqual(saved["purpose"], "public_vehicle")
                store.assert_called_once_with(index)
                index["purpose"] = "private_project"
                path.write_text(documents.canonical(index))
                with self.assertRaises(ValueError):
                    rag.build(path, Path(directory) / "out", "pgvector")
                self.assertEqual(store.call_count, 1)


if __name__ == "__main__":
    unittest.main()
