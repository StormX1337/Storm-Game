"""Matching the same fixture across two vendors that spell teams differently."""

import re
import unicodedata
from datetime import datetime
from difflib import SequenceMatcher

_NOISE = {
    "fc",
    "cf",
    "afc",
    "sc",
    "ac",
    "as",
    "cd",
    "ud",
    "sd",
    "rc",
    "fk",
    "sk",
    "if",
    "bk",
    "club",
    "de",
    "the",
    "calcio",
    "sv",
    "vfb",
    "vfl",
    "tsg",
    "1",
    "ssc",
    "us",
    "ca",
    "cs",
}


def normalize_team(name: str) -> str:
    text = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    text = text.replace("&", " and ")
    tokens = [t for t in re.split(r"[^a-z0-9]+", text) if t and t not in _NOISE]
    return " ".join(tokens)


def team_similarity(a: str, b: str) -> float:
    na, nb = normalize_team(a), normalize_team(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    ta, tb = set(na.split()), set(nb.split())
    jaccard = len(ta & tb) / len(ta | tb)
    contained = 1.0 if (na in nb or nb in na) else 0.0
    ratio = SequenceMatcher(None, na, nb).ratio()
    return max(ratio, jaccard, 0.9 * contained)


def fixture_match_score(
    home_a: str, away_a: str, kickoff_a: datetime, home_b: str, away_b: str, kickoff_b: datetime
) -> float:
    """0..1; fixtures more than three hours apart never match."""
    if abs((kickoff_a - kickoff_b).total_seconds()) > 3 * 3600:
        return 0.0
    return min(team_similarity(home_a, home_b), team_similarity(away_a, away_b))
