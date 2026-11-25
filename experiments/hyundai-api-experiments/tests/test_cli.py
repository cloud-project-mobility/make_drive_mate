import json

import pytest

from hyundai_experiments import cli
from hyundai_experiments.client import run_mock


@pytest.mark.parametrize("save", [True, False])
def test_missing_config_has_exit_two_and_no_network(tmp_path, monkeypatch, capsys, save):
    monkeypatch.setattr(cli, "PROJECT_ROOT", tmp_path)
    args = ["sample", "odometer", "--env-file", str(tmp_path / ".env")]
    if not save:
        args.append("--no-save")
    assert cli.main(args) == 2
    diagnostic = json.loads(capsys.readouterr().out)
    assert diagnostic["network_attempted"] is False
    assert diagnostic["http_status"] is None
    assert bool(list((tmp_path / "output").glob("*.json"))) is save


@pytest.mark.parametrize(
    "scenario,expected",
    [
        ("normal", 0),
        ("unauthorized", 1),
        ("invalid-unit", 1),
    ],
)
def test_mock_cli_scenarios(tmp_path, monkeypatch, capsys, payload, scenario, expected):
    monkeypatch.setattr(cli, "PROJECT_ROOT", tmp_path)
    fixture_dir = tmp_path / "fixtures/mock_responses"
    fixture_dir.mkdir(parents=True)
    (fixture_dir / "odometer.json").write_text(json.dumps(payload), encoding="utf-8")
    assert cli.main(["mock", "odometer", "--scenario", scenario]) == expected
    diagnostic = json.loads(capsys.readouterr().out)
    assert diagnostic["source"] == "MOCK"
    assert diagnostic["network_attempted"] is False


def test_cli_masks_config_values_when_provider_echoes_them(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cli, "PROJECT_ROOT", tmp_path)
    env_file = tmp_path / ".env"
    private = "synthetic-" + "secret-value"
    env_file.write_text(
        "HYUNDAI_SAMPLE_TOKEN=" + private + "\nHYUNDAI_SAMPLE_CAR_ID=mock-car\n", encoding="utf-8"
    )
    monkeypatch.setattr(
        cli,
        "run_sample",
        lambda settings: run_mock({"errMsg": private, "errCode": private}, http_status=401),
    )
    assert cli.main(["sample", "odometer", "--env-file", str(env_file)]) == 1
    stdout = capsys.readouterr().out
    assert private not in stdout
    for output in (tmp_path / "output").glob("*.json"):
        assert private not in output.read_text(encoding="utf-8")
