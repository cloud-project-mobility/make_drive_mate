"""One-request JSON stdin/stdout worker for the Spring service.

Model and credential paths are trusted server arguments, never request fields.
The only stdout content is one JSON response. Provider exceptions are not logged.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
from pathlib import Path

MAX_REQUEST_BYTES = 32768
REQUEST_FIELDS = {"vehicle", "monthly_km", "months", "monthly_upkeep_krw", "use_llm"}
VEHICLE_FIELDS = {
    "make", "model", "fuel", "vehicle_category", "age_years", "odometer_km", "engine_cc"
}


class WorkerError(Exception):
    def __init__(self, code, message, exit_code=2):
        self.code = code
        self.message = message
        self.exit_code = exit_code
        super().__init__(message)


def _reject_constant(_value):
    raise ValueError("Non-finite JSON numbers are not accepted.")


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate JSON object keys are not accepted.")
        value[key] = item
    return value


def _number(value, field, maximum, *, optional=False):
    if value is None and optional:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise WorkerError("INVALID_INPUT", f"{field} must be a JSON number.")
    try:
        converted = float(value)
    except (ValueError, OverflowError):
        raise WorkerError("INVALID_INPUT", f"{field} is outside the allowed input range.") from None
    if not math.isfinite(converted) or not 0 <= converted <= maximum:
        raise WorkerError("INVALID_INPUT", f"{field} is outside the allowed input range.")
    return converted


def parse_request(raw):
    if len(raw) > MAX_REQUEST_BYTES:
        raise WorkerError("REQUEST_TOO_LARGE", "Request must not exceed 32768 bytes.")
    try:
        request = json.loads(
            raw, parse_constant=_reject_constant, object_pairs_hook=_unique_object
        )
    except (ValueError, UnicodeError, RecursionError):
        raise WorkerError("INVALID_JSON", "Expected one valid UTF-8 JSON object.") from None
    if not isinstance(request, dict) or set(request) - REQUEST_FIELDS:
        raise WorkerError("INVALID_INPUT", "Unsupported request fields.")
    vehicle = request.get("vehicle")
    if not isinstance(vehicle, dict) or set(vehicle) - VEHICLE_FIELDS:
        raise WorkerError("INVALID_INPUT", "vehicle must contain only supported vehicle fields.")
    clean_vehicle = {}
    for field in ("make", "model", "fuel", "vehicle_category"):
        value = vehicle.get(field)
        if value is None and field != "model":
            clean_vehicle[field] = "unknown"
            continue
        if not isinstance(value, str) or not value.strip() or len(value) > 100:
            raise WorkerError("INVALID_INPUT", f"{field} must be a nonempty string of at most 100 characters.")
        if any(ord(character) < 32 for character in value):
            raise WorkerError("INVALID_INPUT", f"{field} contains unsupported control characters.")
        clean_vehicle[field] = value.strip()
    for field, maximum in (("age_years", 100), ("odometer_km", 2000000), ("engine_cc", 30000)):
        clean_vehicle[field] = _number(
            vehicle.get(field), field, maximum, optional=field == "engine_cc"
        )
    months = request.get("months", [0, 6, 12])
    if (
        not isinstance(months, list) or not 1 <= len(months) <= 25
        or any(type(month) is not int or not 0 <= month <= 24 for month in months)
        or len(set(months)) != len(months)
    ):
        raise WorkerError("INVALID_INPUT", "months must contain distinct integers from 0 to 24.")
    use_llm = request.get("use_llm", False)
    if not isinstance(use_llm, bool):
        raise WorkerError("INVALID_INPUT", "use_llm must be a JSON boolean.")
    return {
        "vehicle": clean_vehicle,
        "monthly_km": _number(request.get("monthly_km", 1000), "monthly_km", 100000),
        "months": months,
        "monthly_upkeep_krw": _number(
            request.get("monthly_upkeep_krw", 0), "monthly_upkeep_krw", 100000000
        ),
        "use_llm": use_llm,
    }


def _safe_llm_metadata(value):
    result = {}
    for field in ("requested_model", "returned_model", "status", "error_code"):
        item = value.get(field)
        if isinstance(item, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,100}", item):
            result[field] = item
    if isinstance(value.get("http_status"), int):
        result["http_status"] = value["http_status"]
    usage = value.get("usage")
    if isinstance(usage, dict):
        result["usage"] = {
            field: usage[field] for field in ("input_tokens", "output_tokens", "total_tokens")
            if isinstance(usage.get(field), int) and usage[field] >= 0
        }
    return result


def process_request(request, bundle, *, allow_llm=False, env_file=None):
    from onbid_explain import (
        DEFAULT_OPENAI_MODEL,
        explain,
        load_openai_config,
        make_fact_cards,
        openai_selector,
    )
    from onbid_model import build_evidence

    if request["use_llm"] and not allow_llm:
        raise WorkerError("LLM_DISABLED", "LLM calls are disabled by server configuration.")
    evidence = build_evidence(
        bundle, request["vehicle"], monthly_km=request["monthly_km"], months=request["months"],
        monthly_upkeep_krw=request["monthly_upkeep_krw"],
    )
    selector = None
    if request["use_llm"]:
        try:
            config = load_openai_config(env_file) if env_file else {
                "api_key": os.environ.get("OPENAI_API_KEY", ""),
                "model": os.environ.get("OPENAI_MODEL", DEFAULT_OPENAI_MODEL),
            }
            selector = openai_selector(config["api_key"], config["model"])
        except (ValueError, OSError):
            raise WorkerError(
                "LLM_NOT_CONFIGURED", "Server LLM credentials or configuration are unavailable.", 3
            ) from None
    explanation = explain(make_fact_cards(evidence), llm=selector)
    if selector is not None:
        evidence["llm_status"] = (
            "called_verified" if explanation["mode"] == "llm_selected_verified_facts"
            else "call_or_validation_failed"
        )
        explanation["provider_call"] = _safe_llm_metadata(selector.last_call)
    return {"ok": True, "api_version": "onbid-worker-v1", "evidence": evidence, "explanation": explanation}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-bundle", default=os.environ.get("DRIVEMATE_MODEL_BUNDLE"))
    parser.add_argument("--model-sha256", default=os.environ.get("DRIVEMATE_MODEL_SHA256"))
    parser.add_argument("--env-file")
    parser.add_argument("--allow-llm", action="store_true")
    args = parser.parse_args(argv)
    exit_code = 0
    try:
        request = parse_request(sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1))
        if request["use_llm"] and not args.allow_llm:
            raise WorkerError("LLM_DISABLED", "LLM calls are disabled by server configuration.")
        if not args.model_bundle or not Path(args.model_bundle).is_file():
            raise WorkerError("MODEL_UNAVAILABLE", "The server model artifact is unavailable.", 3)
        if args.model_sha256:
            if not re.fullmatch(r"[a-fA-F0-9]{64}", args.model_sha256):
                raise WorkerError("MODEL_UNAVAILABLE", "The server model checksum is invalid.", 3)
            digest = hashlib.sha256(Path(args.model_bundle).read_bytes()).hexdigest()
            if digest.lower() != args.model_sha256.lower():
                raise WorkerError("MODEL_UNAVAILABLE", "The server model checksum does not match.", 3)
        from onbid_model import load_bundle
        bundle = load_bundle(args.model_bundle)
        result = process_request(
            request, bundle, allow_llm=args.allow_llm, env_file=args.env_file
        )
    except WorkerError as error:
        exit_code = error.exit_code
        result = {"ok": False, "error": {"code": error.code, "message": error.message}}
    except Exception:
        # Do not expose filesystem paths, request text, provider errors or credentials.
        exit_code = 3
        result = {"ok": False, "error": {
            "code": "WORKER_FAILED", "message": "Model inference could not be completed."
        }}
    sys.stdout.write(json.dumps(result, ensure_ascii=False, allow_nan=False) + "\n")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
