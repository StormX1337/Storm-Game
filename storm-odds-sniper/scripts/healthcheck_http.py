#!/usr/bin/env python
"""HTTP-Healthcheck ohne curl (das Slim-Image hat keins)."""

from __future__ import annotations

import sys
import urllib.request

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000/health"

try:
    with urllib.request.urlopen(URL, timeout=4) as response:  # noqa: S310 - feste lokale URL
        sys.exit(0 if response.status == 200 else 1)
except Exception as exc:  # noqa: BLE001
    print(f"nicht erreichbar: {exc}", file=sys.stderr)
    sys.exit(1)
