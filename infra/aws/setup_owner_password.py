"""Interactive first password setup; credentials never enter command arguments or output."""
from __future__ import annotations

import argparse
import getpass
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import ssl
import sys
import urllib.error
import urllib.request

SERVICE_ORIGIN = "https://d2a3l7qimjk3ir.cloudfront.net"
SERVICE_HOST = "d2a3l7qimjk3ir.cloudfront.net"
DEFAULT_CONFIG = Path(__file__).resolve().parents[3] / "FE-test/backend/data/deployment/app-secret.json"
MESSAGES = {
    "interactive_required": "사용자가 직접 연 WSL 터미널에서 실행해 주세요. 비밀번호는 화면에 표시하지 않습니다.",
    "diagnostics_enabled": "TLS 진단 기록을 끈 터미널에서 다시 실행해 주세요.",
    "endpoint_unverified": "정해진 HTTPS 서비스의 연결을 확인하지 못했습니다. 비밀번호를 보내지 않았습니다.",
    "initial_config_missing": "로컬 초기 계정 설정 파일이 없습니다. 운영자에게 계정 준비 상태를 확인해 주세요.",
    "initial_config_invalid": "로컬 초기 계정 설정을 확인할 수 없습니다. 파일 내용은 출력하지 않습니다.",
    "password_invalid": "새 비밀번호는 10~128자여야 합니다.",
    "password_mismatch": "두 번 입력한 새 비밀번호가 일치하지 않습니다. 변경하지 않았습니다.",
    "password_unchanged": "초기 비밀번호와 다른 새 비밀번호를 사용해 주세요.",
    "initial_login_failed": "초기 비밀번호가 이미 바뀌었거나 계정 확인에 실패했습니다. 현재 비밀번호를 알면 웹에서 로그인해 주세요.",
    "request_failed": "요청을 완료하지 못했습니다. 비밀번호나 응답 본문은 출력하지 않습니다.",
    "rate_limited": "요청 횟수 제한에 도달했습니다. 잠시 후 다시 시도해 주세요.",
    "invalid_response": "서버 응답을 확인하지 못했습니다.",
    "change_uncertain": "변경 결과를 확인하지 못했습니다. 자동 재시도하지 마세요. 웹에서 새 비밀번호로 로그인해 확인해 주세요.",
    "new_login_unverified": "변경 성공 응답을 받았지만 새 로그인 검증은 완료하지 못했습니다. 웹에서 새 비밀번호로 확인해 주세요.",
    "cleanup_unverified": "임시 확인 세션 종료를 확인하지 못했습니다. 운영자에게 세션 정리를 요청해 주세요.",
}


class SetupError(Exception):
    def __init__(self, code: str, *, changed: bool = False):
        super().__init__(code)
        self.code = code
        self.changed = changed


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise SetupError("request_failed")


class ApiClient:
    def __init__(self):
        if os.environ.get("SSLKEYLOGFILE") or sys.flags.inspect:
            raise SetupError("diagnostics_enabled")
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()),
            NoRedirect(),
        )

    def verify(self) -> None:
        try:
            addresses = socket.getaddrinfo(SERVICE_HOST, 443, type=socket.SOCK_STREAM)
            if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
                raise SetupError("endpoint_unverified")
            health = self.request("/health")
            if health.get("backend") != "spring" or health.get("schema_version") != 2 or health.get("status") != "ok":
                raise SetupError("endpoint_unverified")
        except (OSError, SetupError, ValueError):
            raise SetupError("endpoint_unverified") from None

    def request(self, path: str, method: str = "GET", token: str | None = None, body: dict | None = None) -> dict:
        if path not in {"/health", "/auth/login", "/auth/password", "/auth/logout"}:
            raise SetupError("request_failed")
        headers = {"Accept": "application/json", "Origin": SERVICE_ORIGIN}
        if token:
            headers["Authorization"] = "Bearer " + token
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            SERVICE_ORIGIN + "/api/v1" + path,
            data=None if body is None else json.dumps(body).encode("utf-8"),
            headers=headers,
            method=method,
        )
        try:
            with self.opener.open(request, timeout=30) as response:
                if response.status != 200 or response.geturl() != request.full_url:
                    raise SetupError("invalid_response")
                raw = response.read(65_537)
                if len(raw) > 65_536:
                    raise SetupError("invalid_response")
                result = json.loads(raw)
                if not isinstance(result, dict):
                    raise SetupError("invalid_response")
                return result
        except urllib.error.HTTPError as error:
            raise SetupError("rate_limited" if error.code == 429 else "request_failed") from None
        except (OSError, ValueError, urllib.error.URLError):
            raise SetupError("request_failed") from None


def load_initial_credentials(path: Path) -> tuple[str, str]:
    if not path.is_file():
        raise SetupError("initial_config_missing")
    try:
        if path.stat().st_size > 65_536:
            raise ValueError
        values = json.loads(path.read_text(encoding="utf-8"))
        email = values.get("DRIVEMATE_INITIAL_EMAIL")
        password = values.get("DRIVEMATE_INITIAL_PASSWORD")
        values.clear()
        if not isinstance(email, str) or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
            raise ValueError
        if not isinstance(password, str) or not 10 <= len(password.encode("utf-16-le")) // 2 <= 128:
            raise ValueError
        return email.strip().lower(), password
    except (OSError, ValueError, AttributeError, UnicodeError):
        raise SetupError("initial_config_invalid") from None


def read_new_password() -> str:
    first = getpass.getpass("새 DriveMate 비밀번호: ")
    second = getpass.getpass("새 비밀번호 다시 입력: ")
    if first != second:
        raise SetupError("password_mismatch")
    if not first.strip() or not 10 <= len(first.encode("utf-16-le")) // 2 <= 128:
        raise SetupError("password_invalid")
    return first


def rotate_password(client: ApiClient, email: str, initial: str, new_password: str) -> None:
    if initial == new_password:
        raise SetupError("password_unchanged")
    sessions: list[str] = []
    changed = False
    failure = None
    cleanup_ok = True

    def login(password: str, expected_user: str | None = None) -> str:
        response = client.request("/auth/login", "POST", body={"email": email, "password": password})
        token = response.get("access_token")
        if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token):
            raise SetupError("invalid_response")
        sessions.append(token)
        user = response.get("user")
        if response.get("token_type") != "bearer" or not isinstance(user, dict) or user.get("email") != email:
            raise SetupError("invalid_response")
        user_id = user.get("id")
        if not isinstance(user_id, str) or not user_id or (expected_user is not None and user_id != expected_user):
            raise SetupError("invalid_response")
        return user_id

    try:
        try:
            user_id = login(initial)
        except SetupError as error:
            raise SetupError("rate_limited" if error.code == "rate_limited" else "initial_login_failed") from None
        try:
            response = client.request("/auth/password", "POST", sessions[-1],
                                      {"current_password": initial, "new_password": new_password})
            if response.get("ok") is not True or response.get("reauthentication_required") is not True:
                raise SetupError("invalid_response")
        except SetupError:
            raise SetupError("change_uncertain") from None
        changed = True
        try:
            login(new_password, user_id)
        except SetupError:
            raise SetupError("new_login_unverified", changed=True) from None
    except SetupError as error:
        failure = error
    finally:
        for token in sessions:
            try:
                if client.request("/auth/logout", "POST", token).get("ok") is not True:
                    cleanup_ok = False
            except SetupError:
                cleanup_ok = False
        sessions.clear()
    if not cleanup_ok:
        raise SetupError("cleanup_unverified", changed=changed)
    if failure:
        raise failure


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="사용자가 새 비밀번호를 직접 입력하는 DriveMate 최초 계정 설정")
    parser.add_argument("--initial-config", type=Path, default=DEFAULT_CONFIG, help="기존 로컬 초기 계정 파일 경로; 파일을 수정하지 않음")
    args = parser.parse_args(argv)
    initial = new_password = None
    try:
        if not sys.stdin.isatty() or not sys.stderr.isatty():
            raise SetupError("interactive_required")
        client = ApiClient()
        client.verify()
        print("검증된 DriveMate HTTPS 서비스에서 비밀번호를 변경합니다. 입력은 화면·로그·파일에 저장하지 않습니다.")
        new_password = read_new_password()
        email, initial = load_initial_credentials(args.initial_config)
        rotate_password(client, email, initial, new_password)
        print("비밀번호 변경·새 로그인 확인·임시 세션 종료를 완료했습니다.")
        print("초기설정용 비밀번호는 이제 무효입니다. 초기 파일은 수정하지 않았고 새 비밀번호를 파일에 저장하지 않았습니다.")
        print("웹에서 새 비밀번호로 로그인해 주세요: " + SERVICE_ORIGIN)
        return 0
    except SetupError as error:
        if error.changed:
            print("비밀번호 변경 성공 응답은 확인했습니다. 초기 파일의 비밀번호는 더 이상 유효하지 않습니다.", file=sys.stderr)
        print(MESSAGES.get(error.code, MESSAGES["request_failed"]), file=sys.stderr)
        return 1
    except (EOFError, KeyboardInterrupt):
        print("입력이 취소되었습니다. 비밀번호는 출력하지 않습니다.", file=sys.stderr)
        return 1
    except Exception:
        print(MESSAGES["request_failed"], file=sys.stderr)
        return 1
    finally:
        initial = new_password = None


if __name__ == "__main__":
    raise SystemExit(main())
