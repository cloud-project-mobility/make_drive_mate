"""Count Python calls with fixed public-document and selector fixtures; no remote model or DB."""
import argparse
import json
from pathlib import Path
import sys
from unittest.mock import Mock, patch

parser = argparse.ArgumentParser()
parser.add_argument("repo", type=Path)
args = parser.parse_args()
sys.path.insert(0, str(args.repo / "backend/scripts"))

import assistant_worker
import document_rag as documents
import vehicle_rag
from test_assistant_worker import request
from test_vehicle_rag import fixture, identity, pointer

index = fixture()
connection = Mock()
connection.execute.side_effect = [
    Mock(), Mock(fetchone=lambda: (index["corpus_sha256"], documents.EMBEDDING_MODEL, 1536)),
    Mock(fetchall=lambda: [(index["chunks"][0], index["documents"][0])]),
    Mock(fetchall=lambda: [("manual-tires", 0.8)]),
]
with (patch.object(documents, "pg_connect", return_value=connection),
      patch.object(documents, "bm25_ranking", wraps=documents.bm25_ranking) as lexical,
      patch.object(documents, "vector_literal", wraps=documents.vector_literal) as serialize):
    search = vehicle_rag.retrieve("타이어 점검", identity(), pointer(index), "pgvector", "",
                                  embedder=lambda _: index["vectors"][0])

selector = Mock(return_value=json.dumps({"status": "answered", "answer": "필터를 최근에 교체해서 새것이에요.", "fact_ids": []}))
payload = request()
payload["question"] = "필터를 이미 교체했나요?"
answer = assistant_worker.respond(payload, selector)
print(json.dumps({"bm25_calls": lexical.call_count, "serialize_calls": serialize.call_count,
                  "source_ids": [item["source_id"] for item in search["sources"]],
                  "service_history_selector_calls": selector.call_count, "history_status": answer["status"]}))
