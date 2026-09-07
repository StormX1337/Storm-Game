#!/usr/bin/env python
"""Healthcheck des Scanner-Containers.

Der Scanner hat keinen HTTP-Port. Als Lebenszeichen gilt: mindestens ein
Provider hat innerhalb des Zeitfensters einen Health-Eintrag in Redis
geschrieben.
"""

from __future__ import annotations

import asyncio
import os
import sys

MAX_AGE_SECONDS = float(os.getenv("SCANNER_HEALTH_MAX_AGE", "60"))


async def main() -> int:
    import orjson
    import redis.asyncio as redis

    url = os.getenv("REDIS_URL", "redis://redis:6379/0")
    client = redis.from_url(url, decode_responses=False)
    try:
        await client.ping()
        names = await client.smembers("ph:all")
        if not names:
            print("kein Provider hat Health gemeldet", file=sys.stderr)
            return 1
        keys = [f"ph:{n.decode() if isinstance(n, bytes) else n}" for n in names]
        for payload in await client.mget(keys):
            if not payload:
                continue
            data = orjson.loads(payload)
            age = data.get("seconds_since_message")
            if data.get("healthy") or (age is not None and age <= MAX_AGE_SECONDS):
                print(f"ok: {data.get('name')} status={data.get('status')}")
                return 0
        print("alle Provider gelten als tot", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - Healthcheck meldet nur pass/fail
        print(f"Healthcheck fehlgeschlagen: {exc}", file=sys.stderr)
        return 1
    finally:
        await client.aclose()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
