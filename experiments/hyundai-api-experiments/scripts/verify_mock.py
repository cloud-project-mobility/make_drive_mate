"""Always offline, clearly labelled MOCK."""

from hyundai_experiments.cli import main

if __name__ == "__main__":
    raise SystemExit(main(["mock", "odometer"]))
