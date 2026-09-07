"""Exponentielles Backoff mit Jitter für Reconnects und Rate-Limits."""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass


@dataclass(slots=True)
class ExponentialBackoff:
    """Backoff-Zustand für genau eine Verbindung.

    ``full jitter``: ``sleep = random(0, min(cap, base * 2**attempt))``.
    Verhindert, dass alle Provider nach einem Netzausfall gleichzeitig
    zurückkommen (Thundering Herd).
    """

    base: float = 0.5
    cap: float = 60.0
    factor: float = 2.0
    jitter: bool = True
    attempt: int = 0

    def next_delay(self) -> float:
        raw = min(self.cap, self.base * (self.factor**self.attempt))
        self.attempt += 1
        if not self.jitter:
            return raw
        return random.uniform(raw * 0.5, raw)  # noqa: S311 - kein Krypto-Kontext

    async def sleep(self) -> float:
        delay = self.next_delay()
        await asyncio.sleep(delay)
        return delay

    def reset(self) -> None:
        self.attempt = 0
