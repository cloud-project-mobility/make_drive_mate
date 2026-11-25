import importlib.util
import json

import httpx
import pytest

from hyundai_experiments.config import PROJECT_ROOT, Settings


@pytest.fixture
def importer(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location(
        "importer", PROJECT_ROOT / "scripts/import_official_sample.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "PROJECT_ROOT", tmp_path)
    return module


def test_existing_settings_do_not_trigger_fetch(importer, tmp_path, capsys):
    content = "HYUNDAI_SAMPLE_TOKEN=synthetic-value\nHYUNDAI_SAMPLE_CAR_ID=mock-car\n"
    (tmp_path / ".env").write_text(content)
    assert importer.main() == 0
    assert (tmp_path / ".env").read_text() == content
    assert json.loads(capsys.readouterr().out)["network_attempted"] is False


@pytest.mark.parametrize(
    "domain,expected",
    [
        ("https://dev.kr-ccapi.hyundai.com", 0),
        ("https://unexpected.invalid", 1),
    ],
)
def test_import_only_missing_fields_and_reject_unknown_domain(
    importer, tmp_path, monkeypatch, capsys, domain, expected
):
    content = "# keep this\nHYUNDAI_SAMPLE_TOKEN=kept-demo-token\nHYUNDAI_SAMPLE_CAR_ID=\n"
    (tmp_path / ".env").write_text(content)

    def handler(request):
        assert request.url == importer.INFO_URL
        return httpx.Response(
            200,
            json={
                "result": "OK",
                "data": {
                    "contents": {
                        "domain": domain,
                        "testToken": "published-demo-token",
                        "carIdList": [{"code": "published-demo-car"}],
                    }
                },
            },
        )

    original = httpx.Client
    monkeypatch.setattr(
        httpx, "Client", lambda **kwargs: original(**kwargs, transport=httpx.MockTransport(handler))
    )
    assert importer.main() == expected
    stdout = capsys.readouterr().out
    assert "published-demo-token" not in stdout and "published-demo-car" not in stdout
    saved = Settings.from_env_file(tmp_path / ".env")
    assert saved.sample_token == "kept-demo-token"
    assert "# keep this" in (tmp_path / ".env").read_text()
    assert saved.sample_car_id == ("published-demo-car" if expected == 0 else "")
