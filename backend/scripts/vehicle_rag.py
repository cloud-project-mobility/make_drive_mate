"""Reviewed public manufacturer summaries; never use the private project index."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import document_rag as documents

SCHEMA_VERSION = "vehicle-rag-v1"
PURPOSE = "public_vehicle"
OFFICIAL_HOSTS = {"ownersmanual.hyundai.com", "ownersmanual.kia.com"}
SOURCE_ID = re.compile(r"[A-Za-z0-9_.:-]{1,100}")
MAX_INDEX_BYTES = 128 * 1024 * 1024


def bounded_text(value, maximum, nullable=False):
    if nullable and value is None:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or any(
            ord(c) < 32 and c not in "\n\t" for c in value):
        raise ValueError("Invalid public document text.")
    return value


def official_url(value):
    bounded_text(value, 2000)
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or parsed.hostname not in OFFICIAL_HOSTS or
            parsed.username is not None or parsed.password is not None or parsed.port not in (None, 443) or
            any(ord(c) < 33 for c in value)):
        raise ValueError("Public document URL is not an approved manufacturer URL.")
    return value


def validate_identity(value):
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {"make", "model", "model_year", "fuel"}:
        raise ValueError("Invalid vehicle identity fields.")
    for key in ("make", "model", "fuel"):
        bounded_text(value[key], 100, nullable=True)
        if isinstance(value[key], str) and any(ord(c) < 32 for c in value[key]):
            raise ValueError("Invalid vehicle identity text.")
    year = value["model_year"]
    if year is not None and (type(year) is not int or not 1970 <= year <= datetime.now(timezone.utc).year + 1):
        raise ValueError("Invalid model year.")
    return value


def validate_applicability(value):
    expected = {"scope", "make", "model", "year_from", "year_to", "fuel_types"}
    if not isinstance(value, dict) or set(value) != expected:
        raise ValueError("Invalid document applicability.")
    fuels = value["fuel_types"]
    if not isinstance(fuels, list) or len(fuels) > 20 or any(not isinstance(f, str) for f in fuels) or len(set(fuels)) != len(fuels):
        raise ValueError("Invalid document fuel scope.")
    for fuel in fuels:
        bounded_text(fuel, 100)
    if value["scope"] == "general":
        if any(value[key] is not None for key in ("make", "model", "year_from", "year_to")) or fuels:
            raise ValueError("General guidance cannot claim a vehicle-specific scope.")
    elif value["scope"] == "model_specific":
        for key in ("make", "model"):
            bounded_text(value[key], 100)
        lower, upper = value["year_from"], value["year_to"]
        if type(lower) is not int or not 1970 <= lower <= 2100 or (
                upper is not None and (type(upper) is not int or not lower <= upper <= 2100)):
            raise ValueError("Invalid document model-year scope.")
    else:
        raise ValueError("Unsupported document scope.")


def validate_document(document):
    if not isinstance(document, dict) or document.get("audience") != PURPOSE or document.get("content_kind") != "narrative" or document.get("source_kind") != "official_manual_summary":
        raise ValueError("Only reviewed public vehicle narratives are permitted.")
    if not isinstance(document.get("document_id"), str) or not SOURCE_ID.fullmatch(document["document_id"]):
        raise ValueError("Invalid document identifier.")
    bounded_text(document.get("title"), 200)
    official_url(document.get("source_uri"))
    validate_applicability(document.get("applicability"))


def validate_chunk(chunk, document):
    if not isinstance(chunk, dict) or chunk.get("audience") != PURPOSE or chunk.get("content_kind") != "narrative" or chunk.get("source_kind") != "official_manual_summary":
        raise ValueError("Private or tabular data cannot enter vehicle retrieval.")
    if not isinstance(chunk.get("source_id"), str) or not SOURCE_ID.fullmatch(chunk["source_id"]):
        raise ValueError("Invalid source identifier.")
    if chunk.get("document_id") != document["document_id"] or chunk.get("document_title") != document["title"] or chunk.get("source_uri") != document["source_uri"] or chunk.get("applicability") != document["applicability"]:
        raise ValueError("Chunk provenance differs from its document.")
    bounded_text(chunk.get("parent_id"), 150)
    bounded_text(chunk.get("section"), 200)
    bounded_text(chunk.get("quote"), 1600)
    page = chunk.get("page")
    if page is not None and (type(page) is not int or not 1 <= page <= 10_000):
        raise ValueError("Invalid page reference.")
    documents.secret_check(chunk["quote"])


def validate_public_index(index):
    if not isinstance(index, dict) or index.get("schema_version") != SCHEMA_VERSION or index.get("purpose") != PURPOSE:
        raise ValueError("A dedicated public vehicle collection is required.")
    documents.validate_index(index)
    docs = index.get("documents")
    if not isinstance(docs, list) or not 1 <= len(docs) <= 200:
        raise ValueError("Invalid public document count.")
    lookup = {}
    for document in docs:
        validate_document(document)
        if document["document_id"] in lookup:
            raise ValueError("Duplicate document.")
        lookup[document["document_id"]] = document
    seen, used = set(), set()
    for chunk in index["chunks"]:
        document = lookup.get(chunk.get("document_id"))
        if document is None:
            raise ValueError("Missing source document.")
        validate_chunk(chunk, document)
        if chunk["source_id"] in seen:
            raise ValueError("Duplicate source.")
        seen.add(chunk["source_id"])
        used.add(chunk["document_id"])
    if used != set(lookup):
        raise ValueError("A public document has no reviewed excerpts.")
    return index


def validate_pointer(pointer):
    if not isinstance(pointer, dict) or pointer.get("schema_version") != SCHEMA_VERSION or pointer.get("purpose") != PURPOSE:
        raise ValueError("Private project collections cannot be used for vehicle consultation.")
    digest = pointer.get("corpus_sha256", "")
    if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest) or pointer.get("collection_id") != "rag-" + digest[:20]:
        raise ValueError("Invalid public collection identity.")
    if pointer.get("embedding_model") != documents.EMBEDDING_MODEL or pointer.get("dimensions") != documents.DIMENSIONS:
        raise ValueError("Unsupported public collection embedding configuration.")
    for key, maximum in (("document_count", 200), ("chunk_count", 5000)):
        if type(pointer.get(key)) is not int or not 1 <= pointer[key] <= maximum:
            raise ValueError("Invalid public collection size.")
    return pointer


def read_json(path, limit):
    with Path(path).open("rb") as stream:
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise ValueError("Public collection file is too large.")
    return json.loads(raw, object_pairs_hook=documents.duplicate_guard), raw


def load_pointer(path, expected_sha256):
    if not isinstance(expected_sha256, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", expected_sha256):
        raise ValueError("Public collection checksum is required.")
    pointer, raw = read_json(path, 65536)
    if hashlib.sha256(raw).hexdigest() != expected_sha256.lower():
        raise ValueError("Public collection checksum mismatch.")
    return validate_pointer(pointer)


def normalized(value):
    return re.sub(r"[^a-z0-9가-힣]", "", unicodedata.normalize("NFKC", value).casefold())


def canonical_make(value):
    value = normalized(value)
    return {"현대자동차": "현대", "기아자동차": "기아"}.get(value, value)


def canonical_fuel(value):
    value = normalized(value)
    return {"가솔린": "휘발유", "hev": "하이브리드", "가솔린하이브리드": "하이브리드",
            "휘발유하이브리드": "하이브리드", "ev": "전기"}.get(value, value)


def applies(scope, identity):
    if scope["scope"] == "general":
        return True
    if not identity or any(identity.get(key) is None for key in ("make", "model", "model_year")):
        return False
    return (canonical_make(scope["make"]) == canonical_make(identity["make"]) and
            normalized(scope["model"]) == normalized(identity["model"]) and
            identity["model_year"] >= scope["year_from"] and
            (scope["year_to"] is None or identity["model_year"] <= scope["year_to"]) and
            (not scope["fuel_types"] or identity.get("fuel") is not None and
             canonical_fuel(identity["fuel"]) in {canonical_fuel(fuel) for fuel in scope["fuel_types"]}))


def empty_result(status, method=None):
    return {"scope": PURPOSE, "status": status, "sources": [], "answer_source_ids": [], "method": method}


def source_view(chunk):
    return {"source_id": chunk["source_id"], "document_title": chunk["document_title"],
            "source_uri": chunk["source_uri"], "section": chunk["section"], "page": chunk.get("page"),
            "excerpt": chunk["quote"], "applicability": chunk["applicability"], "source_kind": chunk["source_kind"]}


def rank_sources(question, chunks, ranked, *, lexical=None):
    if lexical is None:
        lexical = documents.bm25_ranking(question, chunks)
    relevant = {identifier for identifier, score in ranked if score >= .30} & {identifier for identifier, _ in lexical}
    fused = documents.reciprocal_rank_fusion([lexical, ranked])
    lookup = {chunk["source_id"]: chunk for chunk in chunks}
    chosen, parents = [], set()
    for identifier in fused:
        if identifier not in relevant:
            continue
        chunk = lookup[identifier]
        if chunk["parent_id"] not in parents:
            chosen.append(source_view(chunk))
            parents.add(chunk["parent_id"])
        if len(chosen) == 3:
            break
    return chosen


def retrieve(question, identity, pointer, backend, api_key, index=None, embedder=None):
    validate_pointer(pointer)
    validate_identity(identity)
    documents.secret_check(question)
    method = "bm25+pgvector-cosine-rrf" if backend == "pgvector" else "bm25+local-cosine-rrf"
    connection = None
    try:
        if backend == "pgvector":
            connection = documents.pg_connect()
            connection.execute("SET LOCAL statement_timeout = '5000'")
            meta = connection.execute("SELECT corpus_sha256,embedding_model,dimensions FROM drivemate_rag.collections WHERE collection_id=%s",
                                      (pointer["collection_id"],)).fetchone()
            if meta != (pointer["corpus_sha256"], documents.EMBEDDING_MODEL, documents.DIMENSIONS):
                raise ValueError("Public collection metadata mismatch.")
            rows = connection.execute("""SELECT c.metadata,d.metadata FROM drivemate_rag.chunks c
                JOIN drivemate_rag.documents d ON d.collection_id=c.collection_id AND d.document_id=c.document_id
                WHERE c.collection_id=%s ORDER BY c.source_id LIMIT 5001""", (pointer["collection_id"],)).fetchall()
            chunks = []
            document_ids, source_ids = set(), set()
            for chunk, document in rows:
                validate_document(document)
                validate_chunk(chunk, document)
                if chunk["source_id"] in source_ids:
                    raise ValueError("Duplicate public source.")
                source_ids.add(chunk["source_id"])
                document_ids.add(document["document_id"])
                chunks.append(chunk)
            if len(chunks) != pointer["chunk_count"] or len(document_ids) != pointer["document_count"]:
                raise ValueError("Public collection counts differ.")
        elif backend == "local":
            validate_public_index(index)
            if (index["corpus_sha256"] != pointer["corpus_sha256"] or
                    len(index["documents"]) != pointer["document_count"] or
                    len(index["chunks"]) != pointer["chunk_count"]):
                raise ValueError("Public local collection mismatch.")
            chunks = index["chunks"]
        else:
            raise ValueError("Unsupported public retrieval backend.")
        eligible = [chunk for chunk in chunks if applies(chunk["applicability"], identity)]
        if not eligible:
            missing = not identity or any(identity.get(key) is None for key in ("make", "model", "model_year"))
            if not missing and identity.get("fuel") is None:
                missing = any(chunk["applicability"]["fuel_types"] and
                              applies({**chunk["applicability"], "fuel_types": []}, identity) for chunk in chunks)
            return empty_result("needs_vehicle_details" if missing else "no_match", method)
        lexical = documents.bm25_ranking(question, eligible)
        if not lexical:
            return empty_result("no_match", method)
        query = question + ("\n차량 입력: " + documents.canonical(identity) if identity else "")
        embedder = embedder or (lambda value: documents.embed([value], api_key, timeout=15)[0][0])
        vector = embedder(query)
        query_vector = documents.vector_literal(vector)
        if connection is not None:
            identifiers = [chunk["source_id"] for chunk in eligible]
            ranked = connection.execute("""SELECT source_id,1-(embedding <=> %s::vector) AS similarity
                FROM drivemate_rag.chunks WHERE collection_id=%s AND source_id=ANY(%s)
                ORDER BY embedding <=> %s::vector,source_id LIMIT 20""",
                (query_vector, pointer["collection_id"], identifiers, query_vector)).fetchall()
        else:
            allowed = {chunk["source_id"] for chunk in eligible}
            ranked = sorted([(chunk["source_id"], sum(a*b for a,b in zip(embedding, vector)))
                             for chunk, embedding in zip(index["chunks"], index["vectors"])
                             if chunk["source_id"] in allowed], key=lambda row: (-row[1], row[0]))[:20]
        sources = rank_sources(question, eligible, ranked, lexical=lexical)
        return {**empty_result("matched" if sources else "no_match", method), "sources": sources}
    finally:
        if connection is not None:
            connection.close()


def retrieve_for_assistant(question, identity, pointer_file, expected_sha256, backend, api_key):
    try:
        pointer = load_pointer(pointer_file, expected_sha256)
        index = None
        if backend == "local":
            relative = pointer.get("index_relative_path", "")
            if not re.fullmatch(r"collections/rag-[a-f0-9]{20}\.json", relative):
                raise ValueError("Invalid local public collection path.")
            base = Path(pointer_file).resolve().parent
            path = (base / relative).resolve()
            if not path.is_relative_to(base):
                raise ValueError("Public collection path leaves its directory.")
            index, _ = read_json(path, MAX_INDEX_BYTES)
        return retrieve(question, identity, pointer, backend, api_key, index)
    except Exception:
        # Provider, DB and filesystem details never enter answers or process logs.
        return empty_result("unavailable")


def build(prepared_index, output_dir, backend):
    if backend not in {"pgvector", "local"}:
        raise ValueError("Unsupported public retrieval backend.")
    index, _ = read_json(prepared_index, MAX_INDEX_BYTES)
    validate_public_index(index)
    storage = documents.store_pgvector(index) if backend == "pgvector" else {"backend": "local"}
    output_dir = Path(output_dir)
    relative = "collections/" + index["collection_id"] + ".json"
    if backend == "local":
        documents.write_json(output_dir / relative, index)
    pointer = {key: index[key] for key in ("schema_version", "purpose", "collection_id", "corpus_sha256", "embedding_model", "dimensions")}
    pointer.update(document_count=len(index["documents"]), chunk_count=len(index["chunks"]),
                   created_at=datetime.now(timezone.utc).isoformat(), storage=storage, index_relative_path=relative)
    target = output_dir / ("active_collection.json" if backend == "pgvector" else "local_collection.json")
    documents.write_json(target, pointer)
    return {"collection_id": index["collection_id"], "document_count": len(index["documents"]),
            "chunk_count": len(index["chunks"]), "pointer_sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
            "external_embedding_called": False, "backend": backend}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["build"])
    parser.add_argument("--prepared-index", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--backend", choices=["pgvector", "local"], default="pgvector")
    args = parser.parse_args(argv)
    try:
        result = build(args.prepared_index, args.output_dir, args.backend)
        print(documents.canonical({"ok": True, "result": result}))
        return 0
    except Exception:
        print(documents.canonical({"ok": False, "error": {"code": "PUBLIC_VEHICLE_INDEX_UNAVAILABLE"}}))
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
