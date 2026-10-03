"""
The PPR-024 egress canary — the POSITIVE CONTROL of the proof
environment's egress denial: a real httpx client (the same transport
library the pinned Browser Use runtime's ChatOpenAI uses) inside the
scrubbed application environment attempts DIRECT provider egress
(https://api.openai.com/v1/models) through the proof proxy. The control
WORKS when the attempt is BLOCKED (the deny proxy refuses and records
the violation); ok=true means blocked — never a passing request.
"""

import json
import os
import sys

import httpx


def main() -> None:
    target = os.environ.get("PPR_024_CANARY_TARGET", "https://api.openai.com/v1/models")
    blocked = False
    detail = ""
    status = 0
    try:
        # httpx honors HTTP(S)_PROXY/NO_PROXY from the environment
        # (trust_env=True) — exactly like the runtime's own transports.
        with httpx.Client(timeout=15.0, trust_env=True) as client:
            response = client.get(target)
            status = response.status_code
            detail = f"HTTP {response.status_code} (body head: {response.text[:120]!r})"
            blocked = response.status_code == 403 and "egress_blocked" in response.text
    except Exception as exc:
        detail = f"{type(exc).__name__}: {exc}"
        # The transport never reached the provider: the deny proxy
        # refused the CONNECT (httpx surfaces ProxyError/ConnectError —
        # either way NO provider response was served).
        blocked = True
    print(json.dumps({"target": target, "blocked": blocked, "status": status, "detail": detail}))
    sys.exit(0 if blocked else 1)


if __name__ == "__main__":
    main()
