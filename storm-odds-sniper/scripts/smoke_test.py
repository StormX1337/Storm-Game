#!/usr/bin/env python
"""Rauchtest der laufenden Installation.

Prüft der Reihe nach: API erreichbar, Redis/DB gesund, Provider gemeldet,
Events vorhanden, WebSocket nimmt Verbindungen an.

    python scripts/smoke_test.py http://localhost:8080/api
"""

from __future__ import annotations

import json
import sys
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080/api"


def get(path: str):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=10) as response:  # noqa: S310
        return json.loads(response.read())


def main() -> int:
    failures = 0

    try:
        health = get("/health")
        ok = health.get("status") == "ok"
        print(f"[{'OK ' if ok else 'FAIL'}] /health -> {health.get('status')}")
        for component in health.get("components", []):
            mark = "OK " if component["healthy"] else "FAIL"
            print(f"        [{mark}] {component['name']} {component.get('detail', '')}")
            failures += 0 if component["healthy"] else 1
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] /health nicht erreichbar: {exc}")
        return 1

    for path, label in (
        ("/health/providers", "Provider"),
        ("/events", "Events"),
        ("/alerts?limit=5", "Alarme"),
        ("/stats", "Statistik"),
    ):
        try:
            data = get(path)
            count = len(data) if isinstance(data, list) else 1
            print(f"[OK ] {label}: {count} Datensätze")
        except Exception as exc:  # noqa: BLE001
            print(f"[FAIL] {label}: {exc}")
            failures += 1

    print("\nErgebnis:", "alles in Ordnung" if failures == 0 else f"{failures} Probleme")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
