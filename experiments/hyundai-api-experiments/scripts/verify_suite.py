"""One request per documented Sample endpoint; never substitute mock data.

Use --resume-from only with this run's successful odometer diagnostic and the
same unchanged local .env. This avoids repeating the initial successful GET.
"""

import argparse
import json
from pathlib import Path

from hyundai_experiments.catalog import APIS
from hyundai_experiments.cli import _save
from hyundai_experiments.client import run_sample
from hyundai_experiments.config import PROJECT_ROOT, Settings
from hyundai_experiments.errors import Status


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resume-from", type=Path)
    args = parser.parse_args()
    settings = Settings.from_env_file()
    records = []
    pending = list(APIS)
    try:
        if args.resume_from:
            evidence = json.loads(args.resume_from.read_text(encoding="utf-8"))
            if not (
                evidence.get("api") == "odometer"
                and evidence.get("source") == "SAMPLE"
                and evidence.get("status") == Status.SAMPLE_VALIDATED
                and evidence.get("network_attempted") is True
                and evidence.get("structure_valid") is True
            ):
                raise ValueError("Invalid prior odometer evidence")
            # Never echo arbitrary content from a supplied file.
            pending.remove("odometer")
        for api in tuple(pending):
            result = run_sample(settings, api)
            safe = result.safe_json(settings)
            _save(safe, PROJECT_ROOT / "output", f"sample-{api}")
            record = json.loads(safe)
            records.append(record)
            pending.remove(api)
            print(
                json.dumps(
                    {
                        key: record[key]
                        for key in (
                            "api",
                            "source",
                            "status",
                            "started_at",
                            "network_attempted",
                            "http_status",
                            "provider_error_code",
                            "elapsed_ms",
                            "json_parsed",
                            "structure_valid",
                            "issues",
                        )
                    },
                    ensure_ascii=False,
                )
            )
            if api == "odometer" and not result.validated:
                break
            if result.status in {
                Status.AUTH_FAILED,
                Status.FORBIDDEN,
                Status.RATE_LIMITED,
                Status.SERVER_ERROR,
                Status.DNS_ERROR,
                Status.TLS_ERROR,
                Status.CONNECTION_ERROR,
                Status.TIMEOUT,
                Status.CONFIG_MISSING,
                Status.CONFIG_INVALID,
            }:
                break
        summary = {
            "resumed_after_odometer": bool(args.resume_from),
            "attempts": records,
            "not_attempted": pending,
            "response_bodies_saved": False,
        }
        _save(json.dumps(summary, ensure_ascii=False, indent=2), PROJECT_ROOT / "output", "suite")
        return (
            0 if not pending and all(r["status"] == Status.SAMPLE_VALIDATED for r in records) else 1
        )
    except (OSError, ValueError, TypeError, KeyError):
        print(json.dumps({"status": "suite_local_error", "details_redacted": True}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
