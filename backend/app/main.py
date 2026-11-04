"""HTTP API. Run locally: uv run uvicorn app.main:app --host 127.0.0.1 --port 18085."""

import sqlite3
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Header, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from starlette.exceptions import HTTPException

from .config import Settings
from .errors import AppError
from .integrations import GoogleIntegration
from .models import Credentials, RouteRequest, StateUpload
from .providers import GoogleCalendarProvider, HyundaiProvider, KakaoProvider, ProviderError
from .store import Store, digest


class BodyLimit:
    """Bound actual ASGI body bytes, including chunked requests without Content-Length."""

    def __init__(self, app, limit: int):
        self.app, self.limit = app, limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        chunks, total = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            total += len(message.get("body", b""))
            if total > self.limit:
                response = JSONResponse(
                    {"error": {"code": "body_too_large", "message": "요청 데이터가 너무 커요."}},
                    status_code=413,
                )
                return await response(scope, receive, send)
            chunks.append(message)
            if not message.get("more_body", False):
                break
        index = 0

        async def replay():
            nonlocal index
            if index < len(chunks):
                message = chunks[index]
                index += 1
                return message
            return await receive()

        await self.app(scope, replay, send)


def create_app(
    settings: Settings | None = None,
    *,
    kakao: KakaoProvider | None = None,
    calendar: GoogleCalendarProvider | None = None,
    hyundai: HyundaiProvider | None = None,
    oauth=None,
    calendar_factory=None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    store = Store(settings.database_path, settings.session_hours)
    # No credential discovery. Inject configured adapters explicitly for live deployments.
    kakao = kakao or KakaoProvider(
        mode=settings.provider_mode,
        rest_key=settings.kakao_rest_key,
        mobility_key=settings.kakao_mobility_key,
    )
    calendar = calendar or GoogleCalendarProvider(mode=settings.provider_mode)
    hyundai = hyundai or HyundaiProvider(mode=settings.provider_mode)
    google = GoogleIntegration(store, settings, oauth=oauth, calendar_factory=calendar_factory)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store.initialize()
        yield

    app = FastAPI(title="DriveMate API", version="0.1.0", lifespan=lifespan)
    app.state.store = store
    app.state.settings = settings
    app.state.google = google
    app.add_middleware(BodyLimit, limit=settings.max_body_bytes)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )

    @app.middleware("http")
    async def no_cache(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(AppError)
    async def app_error(request: Request, exc: AppError):
        headers = {"Retry-After": "60"} if exc.status == 429 else None
        if exc.status == 401:
            headers = {"WWW-Authenticate": "Bearer"}
        return JSONResponse(
            {"error": {"code": exc.code, "message": exc.message}},
            status_code=exc.status,
            headers=headers,
        )

    @app.exception_handler(ProviderError)
    async def provider_error(request: Request, exc: ProviderError):
        return JSONResponse(
            {"error": {"code": exc.code, "message": exc.message, "retryable": exc.retryable}},
            status_code=exc.http_status,
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        # Pydantic's default error response may echo passwords or private payloads.
        return JSONResponse(
            {"error": {"code": "invalid_request", "message": "입력 형식과 범위를 확인해 주세요."}},
            status_code=422,
        )

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
        return JSONResponse(
            {"error": {"code": "http_error", "message": "요청 경로와 접근 권한을 확인해 주세요."}},
            status_code=exc.status_code,
        )

    @app.exception_handler(sqlite3.Error)
    async def storage_error(request: Request, exc: sqlite3.Error):
        return JSONResponse(
            {
                "error": {
                    "code": "storage_unavailable",
                    "message": "저장소를 사용할 수 없어요. 잠시 후 다시 시도해 주세요.",
                }
            },
            status_code=503,
        )

    def token(authorization: Annotated[str | None, Header()] = None) -> str:
        if not authorization or not authorization.startswith("Bearer ") or len(authorization) > 256:
            raise AppError("unauthorized", "로그인이 필요해요.", 401)
        return authorization[7:]

    def user(access_token: str = Depends(token)) -> dict:
        return store.authenticate(access_token)

    def provider_user(current: dict = Depends(user)) -> dict:
        store.rate_limit(f"provider:{current['id']}", 120, 60)
        return current

    prefix = "/api/v1"

    @app.get(prefix + "/health")
    def health():
        # Actually check the database rather than reporting healthy from a constant alone.
        with store.connection() as con:
            con.execute("SELECT 1 FROM accounts LIMIT 1").fetchone()
        return {"status": "ok", "provider_mode": settings.provider_mode, "schema_version": 2}

    def auth_limit(request: Request, email: str):
        # Ignore forwarded headers until a trusted deployment proxy is configured.
        host = request.client.host if request.client else "unknown"
        store.rate_limit("auth-ip:" + digest(host), 30, 60)
        store.rate_limit("auth-email:" + digest(email), 10, 60)

    @app.post(prefix + "/auth/register", status_code=201)
    def register(body: Credentials, request: Request):
        auth_limit(request, body.email)
        return store.register(body.email, body.password)

    @app.post(prefix + "/auth/login")
    def login(body: Credentials, request: Request):
        auth_limit(request, body.email)
        return store.login(body.email, body.password)

    @app.get(prefix + "/auth/me")
    def me(current: dict = Depends(user)):
        return current

    @app.post(prefix + "/auth/logout")
    def logout(access_token: str = Depends(token)):
        store.logout(access_token)
        return {"ok": True}

    @app.delete(prefix + "/account")
    def delete_account(current: dict = Depends(user)):
        google.disconnect(current["id"])
        store.delete_account(current["id"])
        return {"ok": True}

    @app.get(prefix + "/state")
    def get_state(current: dict = Depends(user)):
        return store.state(current["id"])

    @app.put(prefix + "/state")
    def put_state(body: StateUpload, current: dict = Depends(user)):
        return store.save_state(current["id"], body.expected_revision, body.state.snapshot())

    @app.get(prefix + "/integrations")
    def integrations(current: dict = Depends(user)):
        mode = settings.provider_mode
        google_status = google.status(current["id"])
        return {
            "provider_mode": mode,
            "providers": {
                "kakao": {
                    "mode": mode,
                    "source": "mock" if mode == "mock" else "live",
                    "configured": bool(settings.kakao_rest_key),
                    "connected": False,
                    "live_verified": False,
                },
                "google_calendar": {"mode": mode, **google_status},
                "hyundai": {
                    "mode": mode,
                    "configured": False,
                    "connected": False,
                    "live_verified": False,
                },
            },
            "notice": "예시 모드는 외부 API 연결이나 실제 계정 인증을 뜻하지 않습니다.",
        }

    @app.post(prefix + "/integrations/google/authorize")
    def google_authorize(current: dict = Depends(provider_user)):
        return google.authorize(current["id"])

    @app.delete(prefix + "/integrations/google")
    def google_disconnect(current: dict = Depends(user)):
        return google.disconnect(current["id"])

    @app.get(prefix + "/integrations/google/callback", response_class=HTMLResponse)
    def google_callback(
        state: Annotated[str, Query(min_length=1, max_length=256)],
        code: Annotated[str | None, Query(max_length=4096)] = None,
        error: Annotated[str | None, Query(max_length=256)] = None,
    ):
        google.callback(state, code, error)
        return HTMLResponse(
            '<!doctype html><html lang="ko"><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            "<title>DriveMate Google 연결</title><body><h1>Calendar 연결 완료</h1>"
            "<p>DriveMate로 돌아가 일정을 다시 조회해 주세요. 이 창은 닫아도 됩니다.</p>"
            "</body></html>",
            headers={
                "Referrer-Policy": "no-referrer",
                "Content-Security-Policy": "default-src 'none'",
            },
        )

    @app.get(prefix + "/places")
    def places(
        q: Annotated[str, Query(min_length=1, max_length=160)],
        current: dict = Depends(provider_user),
    ):
        if not q.strip():
            raise AppError("invalid_query", "검색할 장소를 입력해 주세요.", 422)
        return kakao.search(q)

    @app.post(prefix + "/routes")
    def route(body: RouteRequest, current: dict = Depends(provider_user)):
        arrival = body.arrival()
        result = kakao.route(body.origin.model_dump(), body.destination.model_dump())
        try:
            departure = arrival - timedelta(
                seconds=result["duration_s"] + 60 * (body.walk_minutes + body.buffer_minutes)
            )
        except OverflowError as exc:
            raise AppError(
                "invalid_arrival", "계산 가능한 도착 날짜를 입력해 주세요.", 422
            ) from exc
        computed = datetime.now(UTC)
        return {
            **result,
            "arrival_at": arrival.isoformat(),
            "departure_at": departure.isoformat(),
            "computed_at": computed.isoformat(),
            "expires_at": (computed + timedelta(minutes=5)).isoformat(),
            "walk_minutes": body.walk_minutes,
            "buffer_minutes": body.buffer_minutes,
        }

    @app.get(prefix + "/calendar/events")
    def calendar_events(
        time_min: datetime | None = None,
        time_max: datetime | None = None,
        current: dict = Depends(provider_user),
    ):
        try:
            start = time_min or datetime.now(UTC)
            end = time_max or start + timedelta(days=30)
            if (
                start.tzinfo is None
                or end.tzinfo is None
                or not timedelta(0) < end - start <= timedelta(days=90)
            ):
                raise ValueError("Invalid calendar window")
            # Offset-aware timestamps at datetime's limits may overflow when
            # normalized to UTC or the provider calendar's local timezone.
            start.astimezone(UTC)
            end.astimezone(UTC)
            if settings.provider_mode == "live":
                return google.list_events(current["id"], time_min=start, time_max=end)
            return calendar.list_events(time_min=start, time_max=end)
        except (ValueError, OverflowError) as exc:
            raise AppError(
                "invalid_window", "일정 조회 기간은 시간대를 포함한 90일 이내여야 해요.", 422
            ) from exc

    @app.get(prefix + "/vehicles/status")
    def vehicle_status(
        powertrain: Literal["ICE", "HYB", "EV"] = "EV",
        current: dict = Depends(provider_user),
    ):
        return hyundai.vehicle_status("mock-vehicle", powertrain=powertrain)

    return app


app = create_app()
