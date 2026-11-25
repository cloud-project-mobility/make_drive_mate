"""Explicit live command; neither normal tests nor mock commands use the network."""

import argparse
import json
import logging
from datetime import UTC, datetime
from pathlib import Path

from .catalog import APIS
from .client import run_mock, run_sample
from .config import PROJECT_ROOT, Settings
from .diagnostics import diagnose_network


def _save(text: str, directory: Path, prefix: str) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    # Fixed prefix and timestamp only; never include a vehicle/user ID.
    with (directory / f"{prefix}-{stamp}.json").open("x", encoding="utf-8") as stream:
        stream.write(text + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="DriveMate Hyundai Sample experiments")
    commands = parser.add_subparsers(dest="command", required=True)
    live = commands.add_parser(
        "sample", help="One official Sample GET, no retries or raw body output"
    )
    live.add_argument("api", choices=list(APIS))
    live.add_argument("--env-file", type=Path, default=PROJECT_ROOT / ".env")
    live.add_argument("--no-save", action="store_true", help="Print diagnostics only")
    mock = commands.add_parser("mock", help="Use a synthetic fixture with MockTransport")
    mock.add_argument("api", choices=list(APIS))
    mock.add_argument(
        "--scenario", choices=["normal", "unauthorized", "invalid-unit"], default="normal"
    )
    commands.add_parser("diagnose", help="No-auth DNS, TCP, HTTPS HEAD probe (not an API test)")
    args = parser.parse_args(argv)
    for name in ("httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.CRITICAL)
    try:
        if args.command == "diagnose":
            data = diagnose_network()
            text = json.dumps(data, ensure_ascii=False, indent=2)
            _save(text, PROJECT_ROOT / "output", "network")
            print(text)
            return 0 if data["https_status"] is not None else 1
        if args.command == "mock":
            fixture = (
                PROJECT_ROOT
                / "fixtures"
                / "mock_responses"
                / ("odometer.json" if args.api == "odometer" else "status.json")
            )
            payload = json.loads(fixture.read_text(encoding="utf-8"))
            if args.api != "odometer":
                payload = payload[args.api]
            if args.scenario == "unauthorized":
                result = run_mock({"errCode": "4011"}, http_status=401, api=args.api)
            elif args.scenario == "invalid-unit":
                if args.api == "odometer":
                    payload["odometers"][0]["unit"] = 77
                elif args.api == "dte":
                    payload["unit"] = 77
                elif args.api == "ev-charging":
                    payload["remainTime"]["unit"] = 77
                else:
                    raise ValueError("This API does not expose a unit code")
                result = run_mock(payload, api=args.api)
            else:
                result = run_mock(payload, api=args.api)
            text = result.safe_json()
            _save(text, PROJECT_ROOT / "output", "mock")
        else:
            settings = Settings.from_env_file(args.env_file)
            result = (
                run_sample(settings) if args.api == "odometer" else run_sample(settings, args.api)
            )
            text = result.safe_json(settings)
            if not args.no_save:
                _save(text, PROJECT_ROOT / "output", f"sample-{args.api}")
        print(text)
        return (
            0
            if result.validated
            else 2
            if not result.network_attempted and (result.source == "SAMPLE")
            else 1
        )
    except (OSError, ValueError):
        # Malformed local input/path errors can contain secrets. Avoid tracebacks.
        print(
            json.dumps(
                {
                    "status": "local_input_or_output_error",
                    "detail": "Check local file encoding, access and disk space.",
                }
            )
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
