"""Explicitly request one Sample odometer read using the project's .env."""

from hyundai_experiments.cli import main

if __name__ == "__main__":
    raise SystemExit(main(["sample", "odometer"]))
