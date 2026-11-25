"""Offline evaluation of retained predictions, lexical retrieval and answer validation."""
import argparse
import csv
import json
import math
import re
import sys
from datetime import UTC, datetime
from pathlib import Path
from statistics import mean

ROOT = Path(__file__).resolve().parent


def price_metrics(rows):
    actual = [float(row["price_krw"]) for row in rows]
    errors = [abs(value - float(row["prediction_krw"])) for value, row in zip(actual, rows)]
    covered = sum(float(row["interval_low_krw"]) <= value <= float(row["interval_high_krw"])
                  for value, row in zip(actual, rows))
    return {"rows": len(rows), "mae_manwon": mean(errors) / 10_000,
            "rmse_manwon": math.sqrt(mean(e ** 2 for e in errors)) / 10_000,
            "wape_pct": sum(errors) / sum(abs(value) for value in actual) * 100,
            "interval_hits": covered, "interval_coverage_pct": covered / len(rows) * 100}


def price_report(model_dir):
    with (model_dir / "test_predictions.csv").open(newline="") as stream:
        rows = list(csv.DictReader(stream))
    supported = [row for row in rows if row["service_supported"].lower() in {"true", "1"}]
    assert 0 < len(supported) <= len(rows)
    metrics = json.loads((model_dir / "metrics.json").read_text())
    overall = price_metrics(rows)
    assert math.isclose(overall["mae_manwon"], metrics["test_metrics"]["mae_manwon"], rel_tol=.00001)
    return {"artifact": model_dir.name, "target": metrics["price_kind"], "all": overall,
            "eligible": price_metrics(supported), "deferred_rows": len(rows) - len(supported),
            "baseline_mae_manwon": {key: row["mae_manwon"] for key, row in metrics["baseline_test_metrics"].items()}}


def price_inference(repo, model_dir):
    sys.path.insert(0, str(repo / "backend/scripts"))
    from onbid_explain import make_fact_cards
    from onbid_model import load_bundle
    from onbid_worker import parse_request, process_request

    # Only load the project's own, locally selected training artifact.
    bundle = load_bundle(model_dir / "model_bundle.joblib")
    template = json.loads((model_dir / "sample_request.json").read_text())
    template["use_llm"] = False
    checks = []
    for label in ["supported-example", "unseen-make-model"]:
        request = {**template, "vehicle": dict(template["vehicle"])}
        if label == "unseen-make-model":
            request["vehicle"].update(make="단위시험제조사", model="단위시험전용모델")
        clean = parse_request(json.dumps(request).encode())
        evidence = process_request(clean, bundle, allow_llm=False)["evidence"]
        cards = {card["id"]: card["statement"] for card in make_fact_cards(evidence)}
        result = {"case": label, "status": evidence["status"], "target": evidence["price_kind"]}
        if label == "supported-example":
            fields = ["prediction_krw", "interval_low_krw", "interval_high_krw"]
            numbers = re.findall(r"([\d,.]+)만원", cards.get("price", "") + " " + cards.get("interval", ""))
            display = [round(float(n.replace(",", "")) * 10_000) for n in numbers]
            errors = [abs(rounded - evidence[field]) for rounded, field in zip(display, fields)]
            result["absolute_display_differences_krw"] = errors
            result["pass"] = (evidence["status"] == "supported_exploratory" and len(errors) == 3
                              and all(e <= 500 for e in errors) and evidence["price_kind"] == "auction_award")
        else:
            result["pass"] = (evidence["status"] == "deferred" and evidence.get("prediction_krw") is None
                              and "price" not in cards and "interval" not in cards)
        checks.append(result)
    return checks


def quality_report(repo, cases):
    sys.path.insert(0, str(repo / "backend/scripts"))
    import assistant_worker
    import document_rag
    import vehicle_rag

    corpus = json.loads((repo / "backend/data/vehicle-rag/reviewed-20261105-v1/corpus.json").read_text())
    chunks = corpus["chunks"]
    vehicles = cases["vehicles"]
    retrieval = []
    for vehicle, question, gold in cases["retrieval"]:
        eligible = [c for c in chunks if vehicle_rag.applies(c["applicability"], vehicles[vehicle])]
        ranking = [key for key, _ in document_rag.bm25_ranking(question, eligible)]
        target = gold + ":summary"
        retrieval.append({"question": question, "expected": target, "top3": ranking[:3],
                          "hit1": target in ranking[:1], "hit3": target in ranking[:3]})
    uncovered = {}
    for vehicle in cases["uncovered_vehicles"]:
        uncovered[vehicle or "unspecified"] = sum(vehicle_rag.applies(c["applicability"], vehicles.get(vehicle))
                                                 for c in chunks)
    # One applicable, public reference is available to the selector. Only its fixed answer is simulated.
    tire_chunk = next(c for c in chunks if c["source_id"] == "avante-2023-tires:summary")
    matched = {**vehicle_rag.empty_result("matched", "fixed-reviewed-source"),
               "sources": [vehicle_rag.source_view(tire_chunk)]}
    judgments = []
    for case in cases["answers"]:
        request = {"question": case["question"], "context": {"demo": False,
                   "vehicle": {"powertrain": "ICE", "odometer_km": 12000}, "next_plan": None,
                   "maintenance": [{"item": "engine-oil", "status": "unrecorded", "recorded": False}]}}
        selection = {"status": "answered", "answer": case["answer"],
                     "fact_ids": ["vehicle_doc:" + s + ":summary" for s in case["sources"]]}
        context = matched if case["sources"] else vehicle_rag.empty_result("no_match")
        result = assistant_worker.respond(request, lambda _: json.dumps(selection), retrieval=context)
        judgments.append({"id": case["id"], "expected": case["expected"], "observed": result["status"],
                          "pass": result["status"] == case["expected"]})
    return {"corpus_chunks": len(chunks), "lexical_tests": retrieval, "out_of_scope_eligible_counts": uncovered,
            "answer_validator_tests": judgments}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    cases = json.loads((ROOT / "quality-cases.json").read_text(encoding="utf-8"))
    result = {"utc": datetime.now(UTC).isoformat(), "network": False, "price": price_report(args.model_dir),
              "model_inference": price_inference(args.repo, args.model_dir),
              **quality_report(args.repo, cases)}
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Price holdout rows:", result["price"]["all"]["rows"])
    for key in ["hit1", "hit3"]:
        print(key, sum(row[key] for row in result["lexical_tests"]), "/", len(result["lexical_tests"]))
    passed = sum(row["pass"] for row in result["answer_validator_tests"])
    print("Answer policy:", passed, "/", len(result["answer_validator_tests"]))
    print("Price inference:", sum(r["pass"] for r in result["model_inference"]), "/", len(result["model_inference"]))
    sys.exit(int(passed != len(result["answer_validator_tests"]) or not all(r["pass"] for r in result["model_inference"])))
