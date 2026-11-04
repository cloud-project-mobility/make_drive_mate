"""Repeatable collect -> preserve -> preprocess -> evaluate -> visualize cycle.

Successful runs publish aggregate analytics only. They never replace a serving model.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import os
import re
import sys
import uuid
from collections import Counter
from datetime import UTC, date, datetime
from pathlib import Path, PurePosixPath

from onbid_data import collect, preprocess
from onbid_model import train

ROOT = Path(__file__).resolve().parents[2]
SCHEMA_VERSION = "drivemate-cycle-v1"


def timestamp():
    return datetime.now(UTC).isoformat()


def write_json(path, value):
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    temporary.replace(path)


def safe_label(value):
    text = " ".join(str(value).split())[:100]
    text = re.sub(r"\d{2,3}\s*[가-힣]\s*\d{4}", "식별정보 제외", text)
    return re.sub(r"20\d{2}-\d{3,}-\d+", "식별정보 제외", text)


def copy_verified_raw(source, destination):
    """Copy only allowlisted raw pages and their verified collection manifest."""
    source = Path(source).resolve()
    manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
    if not manifest.get("complete"):
        raise ValueError("Cannot reuse an incomplete collection.")
    destination.mkdir(parents=True, exist_ok=False)
    seen = set()
    for page in manifest["pages"]:
        relative = PurePosixPath(page["path"])
        if (
            relative.is_absolute() or ".." in relative.parts or "\\" in page["path"]
            or len(relative.parts) != 2 or relative.parts[0] != "raw"
            or relative.suffix != ".json" or str(relative) in seen
        ):
            raise ValueError("The collection contains an unsupported raw page path.")
        seen.add(str(relative))
        original = (source / str(relative)).resolve()
        if source not in original.parents or not original.is_file():
            raise ValueError("A raw page is missing or outside the collection directory.")
        raw = original.read_bytes()
        if hashlib.sha256(raw).hexdigest() != page["sha256"]:
            raise ValueError("A reused raw page does not match its recorded checksum.")
        target = destination / str(relative)
        target.parent.mkdir(exist_ok=True)
        target.write_bytes(raw)
    write_json(destination / "manifest.json", manifest)
    return manifest


def histogram(values, upper_bounds, labels):
    counts = [0] * len(labels)
    for value in values:
        index = next((index for index, bound in enumerate(upper_bounds) if value < bound), len(labels) - 1)
        counts[index] += 1
    return [{"label": label, "count": count} for label, count in zip(labels, counts, strict=True)]


def collection_provenance(mode, collection):
    """Keep calls made here separate from unverified upstream collection history."""
    source_format = collection.get("source_format", "onbid-api-v1")
    imported = source_format == "onbid-export-v1"
    original_calls = collection.get("original_request_count",
                                    None if imported else collection["request_count"])
    return {
        "mode": mode, "date_start": collection["date_start"], "date_end": collection["date_end"],
        "api_calls_this_run": 0 if mode == "reuse" else collection["request_count"],
        "original_collection_calls": original_calls,
        "source_format": source_format,
        "complete_scope": collection.get("complete_scope", "local_import" if imported else "api_collection"),
        "upstream_collection_verified": collection.get(
            "upstream_collection_verified", False if imported else collection.get("complete") is True),
    }


def aggregate_summary(run_id, run_dir, mode, quality, metrics, collection):
    with (run_dir / "data/processed/passenger_clean.csv").open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    with (run_dir / "model/test_predictions.csv").open(encoding="utf-8-sig", newline="") as handle:
        predictions = list(csv.DictReader(handle))
    prices = [float(row["price_krw"]) for row in rows]
    errors = [abs(float(row["price_krw"]) - float(row["prediction_krw"])) for row in predictions]
    model_counts = Counter(safe_label(row["model"]) for row in rows)
    charts = {
        "price_histogram": histogram(
            prices, [1e6, 2e6, 3e6, 5e6, 1e7, 2e7, 5e7, 1e8],
            ["100만원 미만", "100~200만원", "200~300만원", "300~500만원", "500~1천만원",
             "1천~2천만원", "2천~5천만원", "5천만원~1억원", "1억원 이상"],
        ),
        "top_models": [{"label": label, "count": count} for label, count in model_counts.most_common(12)],
        "monthly_counts": [{"label": label, "count": count} for label, count in quality["clean_month_counts"].items()],
        "category_counts": [
            {"label": safe_label(label), "count": count}
            for label, count in sorted(quality["category_counts"].items(), key=lambda item: -item[1])
        ],
        "model_comparison": [
            {"label": label, "mae_manwon": values["mae_krw"] / 10000}
            for label, values in metrics["validation_scores"].items()
        ],
        "absolute_error_histogram": histogram(
            errors, [5e5, 1e6, 2e6, 5e6, 1e7],
            ["50만원 미만", "50~100만원", "100~200만원", "200~500만원", "500~1천만원", "1천만원 이상"],
        ),
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "status": "completed",
        "generated_at": timestamp(),
        "price_kind": "auction_award",
        "production_promoted": False,
        "source": collection_provenance(mode, collection),
        "quality": {
            "raw_rows": quality["raw_rows"], "passenger_rows": quality["passenger_category_rows"],
            "clean_rows": quality["clean_passenger_rows"], "excluded_rows": quality["excluded_rows"],
            "usable_percent_of_passenger": quality["usable_percent_of_passenger"],
            "missing_rates": {field: values["percent"] for field, values in quality["missing_among_passenger"].items()},
            "exclusion_reason_counts": quality["exclusion_reason_counts"],
            "exact_duplicate_rows": quality["exact_duplicate_rows"],
            "repeated_vehicle_groups": quality["repeated_vehicle_groups"],
        },
        "model": {
            "selected_model": metrics["selected_model"],
            "validation_scores": metrics["validation_scores"],
            "test_metrics": metrics["test_metrics"],
            "service_support_audit": metrics["service_support_audit"],
            "split_counts": {name: segment["rows"] for name, segment in metrics["split"]["segments"].items()},
            "source_sha256": metrics["source_sha256"],
        },
        "charts": charts,
        "reports": {"html": f"runs/{run_id}/report.html", "svg": []},
        "review_required": [
            "New model artifacts are candidates; serving-model promotion is a separate review.",
            "Auction prices are not verified retail or dealer-offer prices.",
            "Report conditional supported-subset metrics together with full test metrics and coverage.",
        ],
    }


def bar_svg(title, rows, value_field="count", unit="건", color="#17838b"):
    width, left, right, row_height = 760, 210, 90, 34
    height = 75 + row_height * len(rows)
    maximum = max([float(row[value_field]) for row in rows] or [1]) or 1
    drawing = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img">',
        f'<title>{html.escape(title)}</title>',
        '<rect width="100%" height="100%" fill="#fff" rx="14"/>',
        f'<text x="20" y="30" font-size="17" font-weight="700" fill="#122b3c">{html.escape(title)}</text>',
    ]
    for index, row in enumerate(rows):
        y = 54 + index * row_height
        value = float(row[value_field])
        length = value / maximum * (width - left - right)
        label = safe_label(row["label"])
        short = label if len(label) < 22 else label[:20] + "…"
        formatted = f"{value:,.1f}" if value_field != "count" else f"{int(value):,}"
        drawing.extend([
            f'<text x="20" y="{y + 16}" font-size="13" fill="#43566a"><title>{html.escape(label)}</title>{html.escape(short)}</text>',
            f'<rect x="{left}" y="{y}" width="{length:.2f}" height="23" fill="{color}" rx="4"/>',
            f'<text x="{left + length + 9:.2f}" y="{y + 16}" font-size="12" fill="#122b3c">{formatted}{unit}</text>',
        ])
    return "".join(drawing) + "</svg>"


def render_reports(summary, run_dir):
    charts_dir = run_dir / "charts"
    charts_dir.mkdir()
    quality_rows = [
        {"label": "원본", "count": summary["quality"]["raw_rows"]},
        {"label": "승용차 범주", "count": summary["quality"]["passenger_rows"]},
        {"label": "단일 차량 정제", "count": summary["quality"]["clean_rows"]},
    ]
    definitions = [
        ("quality", "수집에서 분석까지 남은 데이터", quality_rows, "count", "행"),
        ("missing", "승용차 범주의 결측률 (정제 전)",
         [{"label": field, "percent": rate or 0} for field, rate in summary["quality"]["missing_rates"].items()], "percent", "%"),
        ("price_histogram", "정제 차량의 공매 낙찰가 분포", summary["charts"]["price_histogram"], "count", "행"),
        ("top_models", "관측이 많은 모델 · 상위 12개", summary["charts"]["top_models"], "count", "행"),
        ("monthly_counts", "개찰 월별 정제 건수", summary["charts"]["monthly_counts"], "count", "행"),
        ("category_counts", "원본 차량 범주", summary["charts"]["category_counts"], "count", "행"),
        ("model_comparison", "검증 MAE · 낮을수록 좋음", summary["charts"]["model_comparison"], "mae_manwon", "만원"),
        ("absolute_error_histogram", "최종 시험의 절대오차 분포", summary["charts"]["absolute_error_histogram"], "count", "행"),
    ]
    panels = []
    for name, title, rows, field, unit in definitions:
        svg = bar_svg(title, rows, field, unit)
        (charts_dir / f"{name}.svg").write_text(svg, encoding="utf-8")
        summary["reports"]["svg"].append(f"runs/{summary['run_id']}/charts/{name}.svg")
        panels.append('<section class="panel">' + svg + "</section>")
    model = summary["model"]
    audit = model["service_support_audit"]
    conditional = audit["supported_test_metrics"]
    conditional_mae = f"{conditional['mae_manwon']:,.2f}만원" if conditional else "제공 대상 없음"
    source = summary["source"]
    original_calls = source["original_collection_calls"]
    original_calls_label = "미확인" if original_calls is None else f"{original_calls:,}회"
    upstream_note = (
        "파일 가져오기 결과입니다. 파일의 해시·건수·기간을 검사했지만 최초 API 수집의 완전성은 검증하지 않았습니다."
        if source.get("upstream_collection_verified") is False else ""
    )
    page = f'''<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>DriveMate 데이터 사이클</title>
<style>body{{margin:0;background:#edf3f6;color:#122b3c;font:15px/1.6 system-ui,sans-serif}}main{{max-width:1280px;margin:auto;padding:36px 24px}}h1{{font-size:32px;margin:8px 0}}.eyebrow{{color:#17838b;font-weight:700;letter-spacing:.08em}}.cards,.grid{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}}.cards{{grid-template-columns:repeat(4,minmax(0,1fr));margin:26px 0}}.card,.note,.panel{{background:white;border:1px solid #dae5eb;border-radius:16px;padding:18px}}.number{{font-size:26px;font-weight:750}}.label{{color:#526678;font-size:13px}}.note{{margin-bottom:20px;border-left:5px solid #d99523}}.panel{{padding:7px}}svg{{width:100%;height:auto;font-family:system-ui,sans-serif}}footer{{margin:24px 0;color:#526678;font-size:13px}}@media(max-width:750px){{.cards,.grid{{grid-template-columns:1fr}}main{{padding:20px 12px}}}}</style>
<main><div class="eyebrow">DRIVEMATE · DATA CYCLE</div><h1>수집부터 설명 가능한 평가까지</h1>
<p>{source['date_start']} ~ {source['date_end']} · {html.escape(summary['run_id'])} · {html.escape(source['mode'])} 실행</p>
<p>이번 실행 API 호출 {source['api_calls_this_run']:,}회 · 원수집 API 호출 {original_calls_label}. {upstream_note}</p>
<div class="cards"><div class="card"><div class="label">수집 원본</div><div class="number">{summary['quality']['raw_rows']:,}행</div></div>
<div class="card"><div class="label">단일 차량 정제</div><div class="number">{summary['quality']['clean_rows']:,}행</div></div>
<div class="card"><div class="label">전체 시험 MAE</div><div class="number">{model['test_metrics']['mae_manwon']:,.2f}만원</div></div>
<div class="card"><div class="label">시험 자료 중 가격 제공 대상</div><div class="number">{audit['supported_percent']:.2f}%</div></div></div>
<div class="note"><strong>공매 낙찰가를 평가한 결과입니다.</strong> 소비자 시세와 다릅니다. 선택 모델은 {html.escape(model['selected_model'])}이며,
검증 구간으로 선택한 뒤 최종 시험 {model['test_metrics']['rows']:,}행을 평가했습니다.
가격 제공 대상 {audit['supported_rows']:,}행의 조건부 MAE는 {conditional_mae}입니다. 조건부 성능은 전체 성능을 대신하지 않습니다.
새 모델은 검토 후보로만 저장하며 운영 모델을 자동 교체하지 않습니다.</div>
<div class="grid">{''.join(panels)}</div><footer>집계 정보만 표시합니다. 원문 물건명·차량 식별번호·API 키는 포함하지 않습니다.
기간을 달리한 실행은 표본 구성이 다를 수 있습니다. 생성 시각: {html.escape(summary['generated_at'])}</footer></main></html>'''
    (run_dir / "report.html").write_text(page, encoding="utf-8")


def run_cycle(output_root, *, reuse_run=None, start=None, end=None, env_path=None, max_calls=100, n_estimators=200):
    if not 1 <= max_calls <= 100:
        raise ValueError("The collection request budget must be between 1 and 100.")
    if reuse_run is None and (start is None or end is None):
        raise ValueError("Provide --reuse-run or both --start and --end.")
    output_root = Path(output_root)
    output_root.mkdir(parents=True, exist_ok=True)
    lock = output_root / ".cycle.lock"
    descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    run_id = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    with os.fdopen(descriptor, "w") as handle:
        json.dump({"pid": os.getpid(), "run_id": run_id}, handle)
    run_dir = output_root / "runs" / run_id
    run_dir.mkdir(parents=True)
    manifest = {
        "schema_version": SCHEMA_VERSION, "run_id": run_id, "status": "running",
        "started_at": timestamp(), "mode": "reuse" if reuse_run else "collect",
        "production_promoted": False, "stages": [],
        "code_sha256": {
            name: hashlib.sha256((Path(__file__).parent / name).read_bytes()).hexdigest()
            for name in ("onbid_data.py", "onbid_model.py", "onbid_pipeline.py")
        },
    }
    write_json(run_dir / "manifest.json", manifest)
    stage = None

    def begin(name):
        nonlocal stage
        stage = {"name": name, "status": "running", "started_at": timestamp()}
        manifest["stages"].append(stage)
        write_json(run_dir / "manifest.json", manifest)

    def finish():
        stage.update(status="completed", finished_at=timestamp())
        write_json(run_dir / "manifest.json", manifest)

    try:
        begin("reuse_raw" if reuse_run else "collect")
        data_dir = run_dir / "data"
        if reuse_run:
            collection = copy_verified_raw(Path(reuse_run), data_dir)
        else:
            collect(start, end, data_dir, env_path or ROOT / ".env.onbid.local", max_calls)
            collection = json.loads((data_dir / "manifest.json").read_text(encoding="utf-8"))
        finish()
        begin("preprocess")
        quality = preprocess(data_dir)
        finish()
        begin("train_and_evaluate")
        metrics = train(data_dir / "processed/passenger_clean.csv", run_dir / "model", n_estimators, n_jobs=2)
        finish()
        begin("aggregate")
        summary = aggregate_summary(run_id, run_dir, manifest["mode"], quality, metrics, collection)
        finish()
        begin("visualize")
        render_reports(summary, run_dir)
        write_json(run_dir / "summary.json", summary)
        finish()
        manifest.update(status="completed", finished_at=timestamp())
        write_json(run_dir / "manifest.json", manifest)
        write_json(output_root / "latest.json", summary)
        return summary
    except Exception as error:
        manifest.update(status="failed", finished_at=timestamp(), error_type=type(error).__name__)
        if stage is not None:
            stage.update(status="failed", finished_at=timestamp(), error_type=type(error).__name__)
        write_json(run_dir / "manifest.json", manifest)
        raise
    finally:
        attempt = {key: manifest[key] for key in ("run_id", "status", "started_at", "mode")}
        attempt["finished_at"] = manifest.get("finished_at", timestamp())
        attempt["error_type"] = manifest.get("error_type")
        write_json(output_root / "latest-attempt.json", attempt)
        with (output_root / "history.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(attempt, ensure_ascii=False) + "\n")
        lock.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reuse-run", type=Path)
    parser.add_argument("--start", type=date.fromisoformat)
    parser.add_argument("--end", type=date.fromisoformat)
    parser.add_argument("--env", type=Path, default=ROOT / ".env.onbid.local")
    parser.add_argument("--output-root", type=Path, default=ROOT / "backend/data/onbid/pipeline")
    parser.add_argument("--max-calls", type=int, default=100)
    parser.add_argument("--n-estimators", type=int, default=200)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        result = run_cycle(args.output_root, reuse_run=args.reuse_run, start=args.start, end=args.end,
                           env_path=args.env, max_calls=args.max_calls, n_estimators=args.n_estimators)
        print(json.dumps({"run_id": result["run_id"], "status": result["status"],
                          "clean_rows": result["quality"]["clean_rows"], "production_promoted": False}))
        return 0
    except Exception as error:
        # Provider messages and filesystem errors can contain private request/path data.
        print(json.dumps({"status": "failed", "error_type": type(error).__name__,
                          "message": "Inspect the run manifest; request details are omitted."}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
