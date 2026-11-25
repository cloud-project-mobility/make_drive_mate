"""No-auth network probe, explicitly separate from a Sample API request."""

import socket
from datetime import UTC, datetime
from time import perf_counter

import httpx

from .client import HOST
from .errors import transport_status


def diagnose_network() -> dict[str, object]:
    result: dict[str, object] = {
        "source": "NETWORK_DIAGNOSTIC",
        "started_at": datetime.now(UTC).isoformat(),
        "host": HOST,
        "port": 443,
        "sample_api_called": False,
        "dns_ok": False,
        "tcp_ok": False,
        "https_attempted": False,
        "https_status": None,
        "https_error": None,
        "note": "HEAD / without credentials tests HTTPS only; it cannot prove API success.",
    }
    try:
        socket.getaddrinfo(HOST, 443, type=socket.SOCK_STREAM)
        result["dns_ok"] = True
    except OSError:
        result["dns_error"] = "resolution_failed"
    try:
        with socket.create_connection((HOST, 443), timeout=10):
            result["tcp_ok"] = True
    except OSError:
        result["tcp_error"] = "connection_failed"
    start = perf_counter()
    result["https_attempted"] = True
    try:
        with httpx.Client(
            timeout=10, follow_redirects=False, verify=True, trust_env=False
        ) as client:
            response = client.head(f"https://{HOST}/")
            result["https_status"] = response.status_code
    except httpx.RequestError as exc:
        result["https_error"] = transport_status(exc).value
    result["https_elapsed_ms"] = round((perf_counter() - start) * 1000, 2)
    result["completed_at"] = datetime.now(UTC).isoformat()
    return result
