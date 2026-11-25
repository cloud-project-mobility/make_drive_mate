"""Defence in depth for the diagnostic allowlist. Raw responses are never logged."""

import re
from urllib.parse import quote


def redact(text: str, values: tuple[str, ...] = ()) -> str:
    for value in sorted(set(values), key=len, reverse=True):
        if value:
            text = text.replace(value, "[REDACTED]")
            text = text.replace(quote(value, safe=""), "[REDACTED]")
    text = re.sub(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+", "[AUTH REDACTED]", text)
    text = re.sub(r"(/car/status/)[^/\s\"?]+(/odometer)", r"\1[REDACTED]\2", text)
    return text
