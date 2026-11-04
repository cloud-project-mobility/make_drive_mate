"""Collect and normalize authorized Onbid auction awards (standard library only)."""

from __future__ import annotations

import argparse
import calendar
import csv
import hashlib
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

ENDPOINT = "https://apis.data.go.kr/B010003/OnbidCltrBidRsltListSrvc2/getCltrBidRsltList2"
CATALOG = "https://www.data.go.kr/data/15157252/openapi.do"
PROPERTY_CODES = "0007,0010,0005,0004,0002,0003,0006,0008,0011,0013"
PASSENGER_CATEGORIES = {"승용차", "SUV", "경차"}
KST = timezone(timedelta(hours=9))
ROOT = Path(__file__).resolve().parents[2] if len(Path(__file__).resolve().parents) > 2 else Path.cwd()
SCHEMA_VERSION = "onbid-normalized-v2"
EXPORT_FORMAT = "onbid-export-v1"
NORMALIZER_VERSION = "onbid-normalized-v3"
PRIVATE_PATTERNS = (
    re.compile(r"(?<!\d)\d{2,3}\s*[가-힣]\s*\d{4}(?!\d)"),
    re.compile(r"(?<!\d)0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4}(?!\d)"),
    re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
    re.compile(r"(?<!\d)\d{6}\s*[-]\s*[1-8]\d{6}(?!\d)"),
)


class DataError(RuntimeError):
    """An actionable error whose message never contains an API credential."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def save_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def load_key(env_path: Path) -> str:
    key = os.environ.get("ONBID_SERVICE_KEY", "").strip()
    if not key and env_path.exists():
        for line in env_path.read_text(encoding="utf-8-sig").splitlines():
            if line.startswith("ONBID_SERVICE_KEY="):
                key = line.partition("=")[2].strip().strip("\"'")
                break
    if not key:
        raise DataError("ONBID_SERVICE_KEY is missing; set it in the local env file.")
    return urllib.parse.unquote(key)


def month_windows(start: date, end: date):
    current = start
    while current <= end:
        month_end = date(current.year, current.month, calendar.monthrange(current.year, current.month)[1])
        stop = min(month_end, end)
        yield current, stop
        current = stop + timedelta(days=1)


def parse_response(payload: object) -> tuple[list[dict], int, int]:
    if not isinstance(payload, dict):
        raise DataError("API response is not a JSON object.")
    header = payload.get("header", {})
    code = str(header.get("resultCode", ""))
    if code not in {"00", "0", "0000"}:
        safe_code = code if re.fullmatch(r"[A-Za-z0-9_-]{1,40}", code) else "unknown"
        raise DataError(f"Onbid rejected the request (resultCode={safe_code}).")
    body = payload.get("body")
    if not isinstance(body, dict):
        raise DataError("API response has no body object.")
    items = body.get("items") or {}
    rows = items.get("item", []) if isinstance(items, dict) else items
    if rows in (None, ""):
        rows = []
    if isinstance(rows, dict):
        rows = [rows]
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise DataError("API items have an unsupported structure.")
    try:
        total = int(body["totalCount"])
        page_size = int(body["numOfRows"])
    except (KeyError, TypeError, ValueError):
        raise DataError("API pagination metadata is missing or invalid.") from None
    if total < 0 or page_size <= 0:
        raise DataError("API pagination metadata is out of range.")
    return rows, total, page_size


def reject_credentials(value: object) -> None:
    """Do not copy exports containing credentials into a new raw collection."""
    if isinstance(value, dict):
        for key, item in value.items():
            name = re.sub(r"[^a-z]", "", str(key).lower())
            if name in {"servicekey", "apikey", "authorization", "password", "accesstoken", "secretkey"} and item:
                raise DataError("Export contains a credential field; remove it from a separate source export.")
            reject_credentials(item)
    elif isinstance(value, list):
        for item in value:
            reject_credentials(item)
    elif isinstance(value, str) and re.search(r"sk-(?:proj-)?[A-Za-z0-9_-]{30,}|(?:serviceKey|api_key)\s*[=:]\s*\S+", value, re.I):
        raise DataError("Export contains a credential pattern; do not import this file.")


def parse_export(payload: object) -> tuple[list[dict], dict]:
    if not isinstance(payload, dict) or set(payload) != {"meta", "items"}:
        raise DataError("Export must contain exactly meta and items.")
    reject_credentials(payload)
    metadata, rows = payload["meta"], payload["items"]
    if not isinstance(metadata, dict) or not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise DataError("Export metadata/items have an unsupported structure.")
    if metadata.get("endpoint") != ENDPOINT:
        raise DataError("Export endpoint does not match the approved Onbid list service.")
    for field in ("count", "totalCount"):
        if type(metadata.get(field)) is not int or metadata[field] != len(rows):
            raise DataError("Export counts do not match its records; partial exports require review.")
    params = metadata.get("params")
    if not isinstance(params, dict):
        raise DataError("Export query parameters are missing.")
    dates = []
    for field in ("opbdDtStart", "opbdDtEnd"):
        value = params.get(field)
        if not isinstance(value, str) or not re.fullmatch(r"\d{8}", value):
            raise DataError("Export query dates must use YYYYMMDD.")
        try:
            dates.append(datetime.strptime(value, "%Y%m%d").date().isoformat())
        except ValueError:
            raise DataError("Export query dates are invalid.") from None
    if dates[0] > dates[1]:
        raise DataError("Export query dates are reversed.")
    collected = metadata.get("collected_at")
    try:
        if isinstance(collected, str) and collected.endswith(" KST"):
            observed = datetime.strptime(collected, "%Y-%m-%d %H:%M KST").replace(tzinfo=KST)
        else:
            observed = datetime.fromisoformat(collected)
            if observed.utcoffset() is None:
                raise ValueError
    except (TypeError, ValueError):
        raise DataError("Export collected_at must include an explicit timezone.") from None
    return rows, {"date_start": dates[0], "date_end": dates[1], "observed_at": observed.isoformat(),
                  "reported_total_count": metadata["totalCount"], "query_parameters": params}


def decode_export(raw: bytes) -> object:
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise DataError("Export JSON contains a duplicate object key.")
            result[key] = value
        return result

    def reject_constant(_):
        raise DataError("Export JSON contains a non-finite number.")

    try:
        return json.loads(raw.decode("utf-8-sig"), object_pairs_hook=unique_pairs, parse_constant=reject_constant)
    except (UnicodeError, json.JSONDecodeError):
        raise DataError("Export is not valid UTF-8 JSON.") from None


def import_exports(paths: list[Path], output: Path) -> Path:
    """Preserve original exports; complete refers only to this local verified import."""
    if not paths:
        raise DataError("Provide at least one export file.")
    if output.exists():
        raise DataError("Import output already exists; choose a new run directory.")
    checked, seen = [], set()
    for path in paths:
        raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        if digest in seen:
            raise DataError("The same export file was supplied more than once.")
        seen.add(digest)
        rows, metadata = parse_export(decode_export(raw))
        checked.append((raw, digest, len(rows), metadata, path.name))
    output.mkdir(parents=True, exist_ok=False)
    (output / "raw").mkdir()
    now = datetime.now(KST).isoformat()
    manifest = {"schema_version": SCHEMA_VERSION, "normalizer_version": NORMALIZER_VERSION,
                "source": "onbid", "source_format": EXPORT_FORMAT, "catalog_url": CATALOG,
                "endpoint": ENDPOINT, "price_kind": "mixed_auction_results",
                "started_at": now, "complete": False, "complete_scope": "local_import",
                "upstream_collection_verified": False, "request_count": 0,
                "original_request_count": None, "row_count": sum(item[2] for item in checked),
                "date_start": min(item[3]["date_start"] for item in checked),
                "date_end": max(item[3]["date_end"] for item in checked),
                "transform_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                "pages": []}
    save_json(output / "manifest.json", manifest)
    for number, (raw, digest, count, metadata, source_name) in enumerate(checked, 1):
        name = f"raw/export-{number:03d}.json"
        (output / name).write_bytes(raw)
        manifest["pages"].append({"path": name, "sha256": digest, "source_format": EXPORT_FORMAT,
                                  "source_file_name": source_name, "returned_rows": count, **metadata})
    manifest.update(complete=True, completed_at=datetime.now(KST).isoformat())
    save_json(output / "manifest.json", manifest)
    return output


def collect(start: date, end: date, output: Path, env_path: Path, max_calls: int = 100) -> Path:
    if start > end or end >= datetime.now(KST).date():
        raise DataError("Use an ordered date range ending before today (Asia/Seoul).")
    key = load_key(env_path)
    output.mkdir(parents=True, exist_ok=False)
    manifest = {
        "schema_version": SCHEMA_VERSION, "source": "onbid", "price_kind": "auction_award",
        "catalog_url": CATALOG, "endpoint": ENDPOINT,
        "started_at": datetime.now(KST).isoformat(), "date_start": start.isoformat(),
        "date_end": end.isoformat(), "complete": False, "request_count": 0,
        "filters": {"cltrTypeCd": "0002", "prptDivCd": PROPERTY_CODES,
                    "dspsMthodCd": "0001", "pbctStatCd": "0010"},
        "pages": [], "windows": [],
    }
    save_json(output / "manifest.json", manifest)
    opener = urllib.request.build_opener(NoRedirect())
    try:
        for first, last in month_windows(start, end):
            page = 1
            fetched = 0
            expected_total = None
            prior_hashes = set()
            while True:
                params = {**manifest["filters"], "serviceKey": key, "pageNo": page,
                          "numOfRows": 1000, "resultType": "json",
                          "opbdDtStart": first.strftime("%Y%m%d"),
                          "opbdDtEnd": last.strftime("%Y%m%d")}
                raw = None
                for attempt in range(3):
                    if manifest["request_count"] >= max_calls:
                        raise DataError("The configured request budget has been reached.")
                    manifest["request_count"] += 1
                    save_json(output / "manifest.json", manifest)
                    try:
                        request = urllib.request.Request(
                            ENDPOINT + "?" + urllib.parse.urlencode(params),
                            headers={"Accept": "application/json", "User-Agent": "DriveMate-PoC/1.0"},
                        )
                        with opener.open(request, timeout=45) as response:
                            raw = response.read().decode("utf-8-sig")
                        break
                    except urllib.error.HTTPError as error:
                        if error.code not in {429, 500, 502, 503, 504} or attempt == 2:
                            raise DataError(f"Onbid HTTP request failed (status={error.code}).") from None
                    except (urllib.error.URLError, TimeoutError):
                        if attempt == 2:
                            raise DataError("Onbid connection failed after 3 attempts.") from None
                    time.sleep(2 ** attempt)
                if raw is None:
                    raise DataError("Onbid returned no response.")
                # A response should never echo a key; remove it defensively before any persistence.
                raw = raw.replace(key, "[REDACTED]")
                try:
                    payload = json.loads(raw)
                except json.JSONDecodeError:
                    raise DataError("Onbid returned non-JSON; check approval/key activation.") from None
                rows, total, page_size = parse_response(payload)
                if expected_total is None:
                    expected_total = total
                elif total != expected_total:
                    raise DataError("The result count changed during pagination; restart this run.")
                digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
                row_hash = hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()
                if rows and row_hash in prior_hashes:
                    raise DataError("API repeated a page; collection stopped to avoid duplicate inflation.")
                prior_hashes.add(row_hash)
                name = f"raw/{first:%Y%m%d}-{last:%Y%m%d}-p{page:04d}.json"
                path = output / name
                path.parent.mkdir(exist_ok=True)
                path.write_text(raw, encoding="utf-8")
                manifest["pages"].append({"path": name, "sha256": digest,
                    "observed_at": datetime.now(KST).isoformat(), "page": page,
                    "returned_rows": len(rows), "reported_page_size": page_size,
                    "total_count": total, "date_start": first.isoformat(), "date_end": last.isoformat()})
                fetched += len(rows)
                save_json(output / "manifest.json", manifest)
                if fetched >= total:
                    if fetched != total:
                        raise DataError("Fetched rows exceed the API total count.")
                    break
                if not rows or len(rows) != page_size:
                    raise DataError("API returned a short page before reaching its total count.")
                page += 1
                time.sleep(0.2)
            manifest["windows"].append({"date_start": first.isoformat(), "date_end": last.isoformat(),
                                        "total_count": expected_total, "fetched_rows": fetched})
            print(f"{first}..{last}: {fetched} rows", flush=True)
        manifest["complete"] = True
        manifest["completed_at"] = datetime.now(KST).isoformat()
        manifest["row_count"] = sum(page["returned_rows"] for page in manifest["pages"])
    except Exception:
        manifest["failed_at"] = datetime.now(KST).isoformat()
        save_json(output / "manifest.json", manifest)
        raise
    save_json(output / "manifest.json", manifest)
    return output


def clean_text(value: object) -> str | None:
    if value is None:
        return None
    text = " ".join(unicodedata.normalize("NFKC", str(value)).split())
    return None if text.casefold() in {"", "null", "none", "nan", "-", "미상", "미입력"} else text


def integer(value: object) -> int | None:
    text = clean_text(value)
    if text is None:
        return None
    text = re.sub(r"(?:km|원|년|cc)$", "", text, flags=re.IGNORECASE).strip().replace(",", "")
    try:
        number = Decimal(text)
    except InvalidOperation:
        return None
    if not number.is_finite() or number != number.to_integral_value():
        return None
    return int(number)


def auction_date(value: object) -> str | None:
    text = clean_text(value)
    if text is None:
        return None
    formats = ((r"\d{12}", "%Y%m%d%H%M"), (r"\d{14}", "%Y%m%d%H%M%S"),
               (r"\d{8}", "%Y%m%d"), (r"\d{4}-\d{2}-\d{2}", "%Y-%m-%d"))
    for pattern, fmt in formats:
        if re.fullmatch(pattern, text):
            try:
                return datetime.strptime(text, fmt).replace(tzinfo=KST).isoformat()
            except ValueError:
                return None
    return None


def disposition_reasons(value: object) -> list[str]:
    """Quarantine explicit non-car/test, scrap and multi-item price units from source titles.

    `외 N건` does not prove which items a price covers, so it is held for review,
    rather than divided by an assumed vehicle count. Titles themselves stay in raw data.
    """
    title = clean_text(value) or ""
    reasons = []
    if re.search(r"온비드\s*(?:점검|테스트)|점검용|테스트용|시험용\s*(?:데이터|물건)", title):
        reasons.append("non_vehicle_test_record")
    # A prohibition on scrapping is not a requirement to scrap a working vehicle.
    scrap_title = re.sub(r"폐차\s*(?:불가|금지|아님)", "", title)
    if re.search(r"폐차|고철|부품용", scrap_title):
        reasons.append("scrap_or_parts_sale")
    explicit_counts = [int(number.replace(",", ""))
                       for number in re.findall(r"(?<!\d)(\d[\d,]*)\s*대(?!\d)", title)]
    if (any(number > 1 for number in explicit_counts)
            or re.search(r"(?:외|등)\s*[1-9]\d*\s*대|(?:총액\s*)?(?:일괄|묶음)\s*(?:매각|판매)", title)):
        reasons.append("multi_vehicle_lot")
    if re.search(r"외\s*[1-9]\d*\s*건", title):
        reasons.append("multi_item_title_requires_review")
    return reasons


def safe_attribute(value: object) -> tuple[str | None, bool]:
    text = clean_text(value)
    if text is None:
        return None, False
    suspicious = isinstance(value, (dict, list, bool)) or text.startswith(("=", "+", "-", "@"))
    for pattern in PRIVATE_PATTERNS:
        if pattern.search(text):
            suspicious = True
            text = pattern.sub("[REDACTED]", text)
    return ("[REDACTED]" if suspicious and "[REDACTED]" not in text else text), suspicious


def normalize_record(item: dict, observed_at: str, period_start: str, period_end: str) -> dict:
    category, category_private = safe_attribute(item.get("cltrUsgSclsCtgrNm"))
    event_at = auction_date(item.get("cltrOpbdDt"))
    year = integer(item.get("yrmdl"))
    km = integer(item.get("drvDstc"))
    price = integer(item.get("scfbAmt"))
    displacement = integer(item.get("dsvlm"))
    model, model_private = safe_attribute(item.get("carMdlNm"))
    make, make_private = safe_attribute(item.get("cltrMkrNm"))
    fuel, fuel_private = safe_attribute(item.get("fuelCont"))
    vehicle_id = clean_text(item.get("cltrMngNo"))
    condition_id = clean_text(item.get("pbctCdtnNo"))
    event_year = int(event_at[:4]) if event_at else None
    reasons = disposition_reasons(item.get("onbidCltrNm"))
    flags = []
    if any((category_private, model_private, make_private, fuel_private)):
        reasons.append("sensitive_or_unsafe_vehicle_attribute")
    if category not in PASSENGER_CATEGORIES:
        reasons.append("non_passenger_category")
    if clean_text(item.get("pbctStatCd")) != "0010":
        reasons.append("not_awarded")
    if clean_text(item.get("dspsMthodCd")) != "0001":
        reasons.append("not_sale")
    if not vehicle_id or not condition_id:
        reasons.append("missing_event_id")
    if event_at is None:
        reasons.append("invalid_event_date")
    elif not period_start <= event_at[:10] <= period_end:
        reasons.append("event_outside_query_period")
    if year is None or year < 1900 or (event_year is not None and year > event_year + 1):
        reasons.append("invalid_model_year")
    if km is None or km < 0:
        reasons.append("invalid_odometer")
    if price is None or price <= 0:
        reasons.append("invalid_price")
    if model is None:
        reasons.append("missing_model")
    if km == 0:
        flags.append("zero_odometer_requires_review")
        reasons.append("zero_odometer_requires_review")
    if km is not None and km > 1000000:
        flags.append("odometer_over_1m_requires_review")
        reasons.append("odometer_over_1m_requires_review")
    if price is not None and (price < 100000 or price > 300000000):
        flags.append("price_extreme_requires_review")
    age = event_year - year if event_year is not None and year is not None else None
    if age is not None and not 0 <= age <= 80:
        reasons.append("age_outside_model_contract")
    if age is not None and not 1 <= age <= 12:
        flags.append("outside_planned_age_1_to_12")
    if displacement is not None and displacement < 0:
        displacement = None
        flags.append("invalid_displacement")
    record_id = "|".join((vehicle_id or "", condition_id or "", event_at or ""))
    return {
        "source": "onbid", "price_kind": "auction_award", "is_synthetic": False,
        "source_record_id": record_id, "vehicle_group_id": vehicle_id,
        "auction_condition_id": condition_id, "observed_at": observed_at,
        "event_at": event_at, "event_date": event_at[:10] if event_at else None,
        "vehicle_category": category, "make": make, "model": model,
        "model_year": year, "age_years_approx": age, "odometer_km": km,
        "fuel": fuel, "displacement_cc": displacement, "price_krw": price,
        "make_missing": make is None, "fuel_missing": fuel is None,
        "displacement_missing": displacement is None,
        "is_passenger": category in PASSENGER_CATEGORIES,
        "review_flags": ";".join(flags), "exclusion_reasons": ";".join(reasons),
    }


def write_csv(path: Path, rows: list[dict], fieldnames: list[str]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def compare_baseline(path: Path, records: list[dict], clean: list[dict]) -> dict:
    raw = path.read_bytes()
    rows = list(csv.DictReader(raw.decode("utf-8-sig").splitlines()))
    required = {"source_record_id", "vehicle_group_id", "price_krw", "model", "model_year", "odometer_km"}
    if not rows or not required.issubset(rows[0]):
        raise DataError("Baseline CSV is missing the normalized-data contract.")
    baseline = {row["source_record_id"]: row for row in rows}
    if len(baseline) != len(rows) or any(not key or not row["vehicle_group_id"] for key, row in baseline.items()):
        raise DataError("Baseline CSV has missing or duplicate event IDs.")
    source_events = {row["source_record_id"] for row in records}
    clean_events = {row["source_record_id"]: row for row in clean}
    overlap = baseline.keys() & clean_events.keys()
    compare_fields = ("vehicle_category", "make", "model", "model_year", "odometer_km", "fuel",
                      "displacement_cc", "price_krw")
    changes, changed_events = Counter(), 0
    for event in overlap:
        changed = [field for field in compare_fields
                   if clean_text(baseline[event].get(field)) != clean_text(clean_events[event].get(field))]
        changes.update(changed)
        changed_events += bool(changed)
    return {"baseline_sha256": hashlib.sha256(raw).hexdigest(), "baseline_rows": len(rows),
            "scope": "prior_clean_rows_only_not_the_prior_raw_collection",
            "raw_event_overlap": len(baseline.keys() & source_events), "clean_event_overlap": len(overlap),
            "baseline_events_absent_from_raw": len(baseline.keys() - source_events),
            "baseline_events_absent_from_clean": len(baseline.keys() - clean_events.keys()),
            "identical_clean_overlap": len(overlap) - changed_events,
            "changed_clean_overlap": changed_events, "changed_field_counts": dict(changes),
            "clean_group_overlap": len({row["vehicle_group_id"] for row in rows}
                                       & {row["vehicle_group_id"] for row in clean}),
            "new_clean_events": len(clean_events.keys() - baseline.keys()),
            "baseline_rows_appended": False,
            "evaluation_note": "Prior model/test exposure is not erased; define a new dataset and evaluation protocol."}


def preprocess(run: Path, baseline: Path | None = None) -> dict:
    manifest = json.loads((run / "manifest.json").read_text(encoding="utf-8"))
    if not manifest.get("complete"):
        raise DataError("Collection is incomplete; complete collection before preprocessing.")
    records = []
    raw_statuses, raw_dispositions = Counter(), Counter()
    for page in manifest["pages"]:
        raw_path = (run / page["path"]).resolve()
        if run.resolve() not in raw_path.parents or not raw_path.is_file():
            raise DataError("A raw page is missing or outside its run directory.")
        raw = raw_path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != page["sha256"]:
            raise DataError("A raw response checksum does not match the collection manifest.")
        source_format = page.get("source_format", manifest.get("source_format", "onbid-api-v1"))
        if source_format == EXPORT_FORMAT:
            rows, metadata = parse_export(decode_export(raw))
            if any(metadata[field] != page[field] for field in ("observed_at", "date_start", "date_end")):
                raise DataError("Export dates differ from the import manifest.")
        elif source_format == "onbid-api-v1":
            rows, _, _ = parse_response(json.loads(raw))
        else:
            raise DataError("Unsupported raw source format.")
        if "returned_rows" in page and len(rows) != page["returned_rows"]:
            raise DataError("Raw page count differs from its manifest.")
        for item in rows:
            for counter, key in ((raw_statuses, "pbctStatCd"), (raw_dispositions, "dspsMthodCd")):
                code = clean_text(item.get(key))
                counter[code if code and re.fullmatch(r"\d{4}", code) else "unknown"] += 1
            row = normalize_record(item, page["observed_at"], page["date_start"], page["date_end"])
            row["raw_page"] = page["path"]
            records.append(row)
    if len(records) != manifest["row_count"]:
        raise DataError("Raw row count does not match the manifest.")
    grouped = defaultdict(list)
    missing_ids = []
    for row in records:
        if row["vehicle_group_id"] and row["auction_condition_id"] and row["event_at"]:
            grouped[row["source_record_id"]].append(row)
        else:
            missing_ids.append(row)
    normalized = list(missing_ids)
    duplicate_rows = []
    conflict_ids = []
    compare_fields = ["vehicle_category", "make", "model", "model_year", "odometer_km", "fuel",
                      "displacement_cc", "price_krw", "exclusion_reasons"]
    for record_id, group in grouped.items():
        signatures = {json.dumps([row[field] for field in compare_fields], ensure_ascii=False) for row in group}
        if len(signatures) > 1:
            conflict_ids.append(record_id)
            for row in group:
                row["exclusion_reasons"] = ";".join(filter(None, [row["exclusion_reasons"], "conflicting_duplicate"]))
                normalized.append(row)
        else:
            normalized.append(group[0])
            for row in group[1:]:
                row = dict(row)
                row["exclusion_reasons"] = ";".join(filter(None, [row["exclusion_reasons"], "exact_duplicate"]))
                duplicate_rows.append(row)
    normalized.sort(key=lambda row: (row["event_at"] or "", row["source_record_id"]))
    clean = [row for row in normalized if not row["exclusion_reasons"]]
    excluded = [row for row in normalized if row["exclusion_reasons"]] + duplicate_rows
    fieldnames = list(records[0]) if records else list(normalize_record({}, "", "", "")) + ["raw_page"]
    processed = run / "processed"
    processed.mkdir(exist_ok=True)
    write_csv(processed / "normalized_all.csv", normalized, fieldnames)
    write_csv(processed / "passenger_clean.csv", clean, fieldnames)
    write_csv(processed / "excluded.csv", excluded, fieldnames)
    passenger = [row for row in normalized if row["is_passenger"]]
    missing = {field: {"count": sum(row[field] is None for row in passenger),
                       "percent": round(100 * sum(row[field] is None for row in passenger) / len(passenger), 2) if passenger else None}
               for field in ["make", "model", "model_year", "odometer_km", "fuel", "displacement_cc", "price_krw", "event_date"]}
    reason_counts = Counter(reason for row in excluded for reason in row["exclusion_reasons"].split(";") if reason)
    flags = Counter(flag for row in clean for flag in row["review_flags"].split(";") if flag)
    dates = [row["event_date"] for row in clean]
    models = Counter(row["model"] for row in clean)
    groups = Counter(row["vehicle_group_id"] for row in clean)
    report = {
        "schema_version": SCHEMA_VERSION, "price_kind": "auction_award",
        "normalizer_version": NORMALIZER_VERSION,
        "generated_at": datetime.now(KST).isoformat(),
        "collection_complete": manifest.get("source_format") != EXPORT_FORMAT,
        "local_import_complete": manifest.get("source_format") == EXPORT_FORMAT,
        "source_format": manifest.get("source_format", "onbid-api-v1"),
        "upstream_collection_verified": manifest.get("upstream_collection_verified", True),
        "original_request_count": manifest.get("original_request_count", manifest["request_count"]),
        "requested_range": [manifest["date_start"], manifest["date_end"]],
        "raw_rows": len(records), "normalized_rows": len(normalized),
        "exact_duplicate_rows": len(duplicate_rows), "conflicting_duplicate_events": len(conflict_ids),
        "passenger_category_rows": len(passenger), "clean_passenger_rows": len(clean),
        "excluded_rows": len(excluded),
        "usable_percent_of_raw": round(len(clean) / len(records) * 100, 2) if records else 0,
        "usable_percent_of_passenger": round(len(clean) / len(passenger) * 100, 2) if passenger else 0,
        "clean_date_range": [min(dates), max(dates)] if dates else [],
        "passenger_categories": sorted(PASSENGER_CATEGORIES),
        "category_counts": dict(Counter(row["vehicle_category"] or "unknown" for row in normalized)),
        "missing_among_passenger": missing, "exclusion_reason_counts": dict(reason_counts),
        "review_flag_counts_among_clean": dict(flags),
        "unique_vehicle_groups": len(groups), "repeated_vehicle_groups": sum(count > 1 for count in groups.values()),
        "top_models": models.most_common(25),
        "clean_month_counts": dict(sorted(Counter(row["event_date"][:7] for row in clean).items())),
        "request_count": manifest["request_count"],
        "raw_status_counts": dict(raw_statuses), "raw_disposition_counts": dict(raw_dispositions),
        "privacy": {"raw_contains_unredacted_source": True, "raw_must_remain_private": True,
                    "feature_attribute_patterns": ["vehicle_plate", "phone", "email", "resident_number"],
                    "sensitive_feature_rows_excluded": reason_counts["sensitive_or_unsafe_vehicle_attribute"],
                    "pattern_scan_is_not_complete_deidentification": True},
        "notes": [
            "The target is an auction award, not a retail/dealer-offer/completed-transaction price.",
            "Only explicit source passenger categories are selected; model names are not used to guess a category.",
            "Missing make/fuel/displacement are retained and flagged; no data-dependent imputation was fitted.",
            "Source titles quarantine scrap/parts sales, explicit multiple-vehicle lots, test records and unresolved 'additional N items' lots.",
            "Zero or over-one-million-km odometers require source verification and are excluded from model-ready data.",
            "Extreme price alone is only flagged, not filtered: target-dependent truncation is not used.",
            "Clean means required fields are structurally valid; review flags are retained and need model-stage decisions.",
            "Model age is approximate from model year; original registration date/trim/accident history are unavailable.",
            "Use chronological splits and prevent vehicle_group_id overlap. IDs, observed_at, price and post-auction fields are not features.",
            "Spelling variants are not automatically merged into an unverified model generation.",
        ],
    }
    if baseline is not None:
        report["baseline_overlap"] = compare_baseline(baseline, records, clean)
        save_json(processed / "baseline_overlap.json", report["baseline_overlap"])
    save_json(processed / "quality_report.json", report)
    lines = ["# 온비드 수집·전처리 결과", "", f"- 요청 기간: {manifest['date_start']} ~ {manifest['date_end']}",
             f"- 원본: {len(records):,}행 / API 요청: {manifest['request_count']}회",
             f"- 동일 이벤트 중복 제거: {len(duplicate_rows):,}행 / 값 충돌 이벤트: {len(conflict_ids):,}개",
             f"- 승용차 범주: {len(passenger):,}행 / 필수 필드 유효: {len(clean):,}행",
             f"- 원본 대비 사용 가능 비율: {report['usable_percent_of_raw']}%",
             f"- 승용차 범주 내 사용 가능 비율: {report['usable_percent_of_passenger']}%", "",
             "가격은 공매 낙찰가이며 소비자 시세가 아닙니다. 원본 제목의 폐차·고철·다대 차량·외 N건·점검용 기록과 주행거리 검토대기를 제외했습니다.",
             "가격이 크거나 작다는 이유만으로 제외하지 않으며, 남아 있는 `review_flags`도 확인해야 합니다.",
             "", "## 승용차 결측률", "", "| 필드 | 결측 건수 | 비율 |", "|---|---:|---:|"]
    if manifest.get("source_format") == EXPORT_FORMAT:
        lines[4:4] = ["- API 요청 0회는 이번 오프라인 가져오기 기준입니다. 원 수집 호출 횟수·전체 수집 완전성은 검증하지 않았습니다."]
    lines += [f"| {field} | {value['count']} | {value['percent']}% |" for field, value in missing.items()]
    lines += ["", "## 제외 사유 (한 행에 복수 사유 가능)", ""]
    lines += [f"- {reason}: {count:,}행" for reason, count in reason_counts.items()]
    lines += ["", "## 모델 단계에서 지킬 점", "", "- 차량 그룹이 훈련/검증/테스트에 걸치지 않도록 날짜순 분할합니다.",
              "- 결측 대체·범주 사전·이상값 기준은 훈련 데이터에만 맞춥니다.",
              "- 차량번호/주소/물건명·입찰자 수/낙찰가율/감정가는 정제 CSV에 포함하지 않았습니다.",
              "- 동일 차량의 미래 감가 경로는 이번 횡단면 자료만으로 검증되지 않습니다."]
    lines += ["- 원본은 비공개이며 정제본도 물건 식별자를 포함합니다. 패턴 가림은 완전한 비식별화를 보장하지 않습니다."]
    (processed / "quality_report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    fetch = commands.add_parser("collect")
    fetch.add_argument("--start", type=date.fromisoformat, required=True)
    fetch.add_argument("--end", type=date.fromisoformat, required=True)
    fetch.add_argument("--output", type=Path, required=True)
    fetch.add_argument("--env", type=Path, default=ROOT / ".env.onbid.local")
    fetch.add_argument("--max-calls", type=int, default=100)
    clean = commands.add_parser("preprocess")
    clean.add_argument("--run", type=Path, required=True)
    clean.add_argument("--baseline", type=Path)
    imported = commands.add_parser("import-export")
    imported.add_argument("--files", type=Path, nargs="+", required=True)
    imported.add_argument("--output", type=Path, required=True)
    imported.add_argument("--baseline", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.command == "collect":
            run = collect(args.start, args.end, args.output, args.env, args.max_calls)
            print(f"COLLECTION_COMPLETE={run}")
        else:
            run = import_exports(args.files, args.output) if args.command == "import-export" else args.run
            report = preprocess(run, args.baseline)
            print(json.dumps({key: report[key] for key in ["raw_rows", "clean_passenger_rows", "excluded_rows", "request_count"]}))
    except DataError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"ERROR: {type(error).__name__}; inspect local paths/input format (credentials omitted).", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
