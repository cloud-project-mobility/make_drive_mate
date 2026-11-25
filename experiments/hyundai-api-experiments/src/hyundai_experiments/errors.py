"""Stable categories and safe descriptions; no exception/body echoing."""

import socket
import ssl
from enum import StrEnum

import httpx


class Status(StrEnum):
    SAMPLE_VALIDATED = "sample_validated"
    MOCK_VALIDATED = "mock_only_validated"
    SCHEMA_UNVERIFIED = "http_json_received_schema_unverified"
    AUTH_FAILED = "authentication_failed"
    FORBIDDEN = "permission_denied"
    RATE_LIMITED = "rate_limited"
    SERVER_ERROR = "provider_server_error"
    PROVIDER_ERROR = "provider_error"
    HTTP_ERROR = "http_error"
    REDIRECT = "redirect_not_followed"
    INVALID_JSON = "invalid_json"
    DNS_ERROR = "dns_error"
    TLS_ERROR = "tls_error"
    CONNECTION_ERROR = "connection_error"
    TIMEOUT = "timeout"
    CONFIG_MISSING = "configuration_missing"
    CONFIG_INVALID = "configuration_invalid"
    NOT_VERIFIED = "not_verified"
    SAMPLE_UNSUPPORTED_CONFIRMED = "sample_unsupported_confirmed"


def transport_status(error: BaseException) -> Status:
    if isinstance(error, httpx.TimeoutException):
        return Status.TIMEOUT
    current: BaseException | None = error
    visited: set[int] = set()
    while current is not None and id(current) not in visited:
        visited.add(id(current))
        if isinstance(current, ssl.SSLError):
            return Status.TLS_ERROR
        if isinstance(current, socket.gaierror):
            return Status.DNS_ERROR
        # Some httpcore/platform combinations only keep an OSError message.
        # Use it for classification, never return or print the message itself.
        message = str(current).lower()
        if "certificate_verify_failed" in message or "ssl:" in message:
            return Status.TLS_ERROR
        if any(
            part in message
            for part in (
                "getaddrinfo failed",
                "name or service not known",
                "nodename nor servname",
                "temporary failure in name resolution",
                "11001",
                "알려진 호스트가 없습니다",
            )
        ):
            return Status.DNS_ERROR
        current = current.__cause__ or current.__context__
    return Status.CONNECTION_ERROR


class SchemaError(ValueError):
    """Only fixed field names/reason codes, never untrusted response values."""
