"""Normalisierung von Teams, Spielern, Märkten und Events.

Die Datenquellen schreiben Namen unterschiedlich ("FC Bayern München",
"Bayern Munich", "Bayern"). Ohne Normalisierung vergleicht der Scanner Quoten
verschiedener Events miteinander - die häufigste Quelle für False Positives.

Zwei Stufen:

1. ``normalize_team`` / ``normalize_player``: deterministischer Kanonik-Slug.
2. ``EventMatcher``: Fuzzy-Zuordnung über Slug-Ähnlichkeit + Datum, damit
   Provider mit leicht abweichender Schreibweise dasselbe Event treffen.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from backend.models.domain import MarketKey, Selection
from backend.models.enums import MarketType, Period, SelectionCode, Sport

# Rechtsformen/Zusätze, die keinerlei Unterscheidungskraft haben.
_CLUB_NOISE = {
    "fc",
    "cf",
    "sc",
    "ac",
    "afc",
    "if",
    "bk",
    "sk",
    "ss",
    "as",
    "us",
    "cd",
    "ud",
    "sv",
    "tsv",
    "vfl",
    "vfb",
    "fsv",
    "msv",
    "spvgg",
    "bsc",
    "rb",
    "cfr",
    "nk",
    "hk",
    "ff",
    "fk",
    "gc",
    "club",
    "calcio",
    "futbol",
    "football",
    "fussball",
    "voetbal",
    "fotbal",
    "team",
    "the",
    "de",
    "of",
    "el",
    "la",
    "los",
    "des",
    "du",
}

_SUFFIX_NOISE = {"ii", "b", "u21", "u23", "u19", "reserves", "res", "amateure", "ladies", "women"}

# Bewusst kleine, gepflegte Alias-Tabelle. Alles andere macht die Fuzzy-Stufe.
_TEAM_ALIASES: dict[str, str] = {
    "bayern": "bayern munchen",
    "bayern munich": "bayern munchen",
    "bayern muenchen": "bayern munchen",
    "borussia dortmund": "dortmund",
    "bvb": "dortmund",
    "borussia monchengladbach": "monchengladbach",
    "gladbach": "monchengladbach",
    "man united": "manchester united",
    "man utd": "manchester united",
    "man city": "manchester city",
    "spurs": "tottenham hotspur",
    "tottenham": "tottenham hotspur",
    "wolves": "wolverhampton wanderers",
    "inter milan": "internazionale",
    "inter": "internazionale",
    "psg": "paris saint germain",
    "paris sg": "paris saint germain",
    "atletico madrid": "atletico de madrid",
    "atl madrid": "atletico de madrid",
    "barcelona": "fc barcelona",
    "leipzig": "rb leipzig",
    "hoffenheim": "tsg hoffenheim",
    "eintracht frankfurt": "frankfurt",
    "bayer leverkusen": "leverkusen",
}

_WS_RE = re.compile(r"\s+")
_NON_ALNUM_RE = re.compile(r"[^a-z0-9 ]+")


def strip_accents(text: str) -> str:
    """Diakritika entfernen; ß wird zu ss (sonst fällt es ersatzlos weg)."""
    text = text.replace("ß", "ss").replace("ẞ", "ss")
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def basic_clean(text: str) -> str:
    out = strip_accents(text or "").lower()
    out = out.replace("&", " and ").replace("'", "").replace(".", " ").replace("-", " ")
    out = _NON_ALNUM_RE.sub(" ", out)
    return _WS_RE.sub(" ", out).strip()


def normalize_team(name: str) -> str:
    """Kanonischer Slug für einen Vereinsnamen."""
    cleaned = basic_clean(name)
    if not cleaned:
        return ""
    cleaned = _TEAM_ALIASES.get(cleaned, cleaned)
    tokens = [t for t in cleaned.split(" ") if t]
    # Führende/abschließende Rechtsformen entfernen, aber niemals alles wegwerfen.
    filtered = [t for t in tokens if t not in _CLUB_NOISE and not t.isdigit()]
    while filtered and filtered[-1] in _SUFFIX_NOISE:
        filtered.pop()
    if not filtered:
        filtered = tokens
    slug = "_".join(filtered)
    return _TEAM_ALIASES.get(slug.replace("_", " "), slug.replace(" ", "_")).replace(" ", "_")


def normalize_player(name: str) -> str:
    """Kanonischer Slug für einen Tennisspieler.

    Unterstützt "Jannik Sinner", "Sinner J.", "J. Sinner", "Sinner, Jannik"
    und "SINNER Jannik" (Nachname in Großbuchstaben - so schreiben es einige
    Turnier-Feeds). Ergebnis ist immer ``nachname_initial``
    (z. B. ``sinner_j``), damit alle Schreibweisen zusammenfallen.
    """
    raw = (name or "").strip()
    if not raw:
        return ""
    if "," in raw:
        last, _, first = raw.partition(",")
        raw = f"{first.strip()} {last.strip()}"

    # "SINNER Jannik": genau ein Token in Versalien -> das ist der Nachname.
    original_tokens = [t for t in re.split(r"[\s.]+", raw) if t]
    if len(original_tokens) > 1:
        shouted = [t for t in original_tokens if len(t) > 1 and t.isupper()]
        normal = [t for t in original_tokens if not (len(t) > 1 and t.isupper())]
        if len(shouted) == 1 and normal:
            surname = basic_clean(shouted[0]).replace(" ", "")
            initial = basic_clean(normal[0])[:1]
            if surname and initial:
                return f"{surname}_{initial}"

    cleaned = basic_clean(raw)
    tokens = [t for t in cleaned.split(" ") if t]
    if not tokens:
        return ""
    if len(tokens) == 1:
        return tokens[0]

    initials = [t for t in tokens if len(t) == 1]
    words = [t for t in tokens if len(t) > 1]
    if not words:
        return "_".join(tokens)
    if initials:
        # "Sinner J." oder "J. Sinner" -> Nachname ist das lange Token.
        surname = words[-1] if tokens[0] in initials else words[0]
        # Bei mehreren langen Tokens gewinnt das letzte lange Token als Nachname,
        # außer die Initiale steht am Ende ("Sinner J.").
        if tokens[-1] in initials:
            surname = words[0]
        return f"{surname}_{initials[0]}"
    surname = words[-1]
    return f"{surname}_{words[0][0]}"


def normalize_participant(sport: Sport, name: str) -> str:
    return normalize_player(name) if sport is Sport.TENNIS else normalize_team(name)


def normalize_bookmaker(name: str) -> str:
    cleaned = basic_clean(name)
    return cleaned.replace(" ", "_") or "unknown"


def normalize_league(name: str | None) -> str | None:
    if not name:
        return None
    return _WS_RE.sub(" ", name.strip())


# ------------------------------------------------------------------ Ähnlichkeit


def _bigrams(text: str) -> set[str]:
    return {text[i : i + 2] for i in range(len(text) - 1)} or {text}


def similarity(a: str, b: str) -> float:
    """Dice-Koeffizient über Bigramme - schnell und robust gegen Tippfehler."""
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    ba, bb = _bigrams(a), _bigrams(b)
    inter = len(ba & bb)
    return (2.0 * inter) / (len(ba) + len(bb))


# ------------------------------------------------------------- Event-Matching


@dataclass(slots=True)
class CanonicalEvent:
    event_id: str
    sport: Sport
    home_norm: str
    away_norm: str
    home: str
    away: str
    date_key: str
    providers: set[str] = field(default_factory=set)


@dataclass(slots=True)
class MatchResult:
    event_id: str
    swapped: bool
    created: bool
    score: float = 1.0


def _date_key(start: datetime | None) -> str:
    return start.date().isoformat() if start else "unknown"


def make_event_id(sport: Sport, a_norm: str, b_norm: str, date_key: str) -> str:
    first, second = sorted((a_norm, b_norm))
    digest = hashlib.sha1(  # noqa: S324 - reine ID-Bildung, keine Kryptographie
        f"{sport.value}|{first}|{second}|{date_key}".encode()
    ).hexdigest()[:16]
    return f"{sport.value[:3]}_{digest}"


class EventMatcher:
    """Ordnet Provider-Events einer providerübergreifenden, stabilen ID zu.

    ``swapped=True`` bedeutet: der Provider führt Heim/Auswärts umgekehrt zum
    bereits registrierten Event. Der Scanner spiegelt dann Selektion und Linie,
    damit nie ein Heim- gegen einen Auswärtspreis verglichen wird.
    """

    def __init__(self, threshold: float = 0.82, ttl_hours: int = 48) -> None:
        self.threshold = threshold
        self.ttl = timedelta(hours=ttl_hours)
        self._by_id: dict[str, CanonicalEvent] = {}
        self._buckets: dict[tuple[Sport, str], list[str]] = {}
        self._exact: dict[tuple[Sport, str, str, str], str] = {}

    # ------------------------------------------------------------------ API
    def match(
        self,
        sport: Sport,
        home: str,
        away: str,
        start_time: datetime | None,
        provider: str = "",
    ) -> MatchResult:
        home_norm = normalize_participant(sport, home)
        away_norm = normalize_participant(sport, away)
        if not home_norm or not away_norm:
            raise ValueError("Teilnehmer konnten nicht normalisiert werden")

        dkey = _date_key(start_time)
        exact_key = (sport, dkey, home_norm, away_norm)
        if (hit := self._exact.get(exact_key)) is not None:
            self._by_id[hit].providers.add(provider)
            return MatchResult(hit, swapped=False, created=False)
        swapped_key = (sport, dkey, away_norm, home_norm)
        if (hit := self._exact.get(swapped_key)) is not None:
            self._by_id[hit].providers.add(provider)
            return MatchResult(hit, swapped=True, created=False)

        best: tuple[float, str, bool] | None = None
        for candidate_id in self._candidate_ids(sport, start_time):
            cand = self._by_id[candidate_id]
            direct = min(
                similarity(home_norm, cand.home_norm), similarity(away_norm, cand.away_norm)
            )
            reverse = min(
                similarity(home_norm, cand.away_norm), similarity(away_norm, cand.home_norm)
            )
            score, swapped = (direct, False) if direct >= reverse else (reverse, True)
            if score >= self.threshold and (best is None or score > best[0]):
                best = (score, candidate_id, swapped)

        if best is not None:
            score, event_id, swapped = best
            canonical = self._by_id[event_id]
            canonical.providers.add(provider)
            key = (
                (sport, dkey, away_norm, home_norm)
                if swapped
                else (sport, dkey, home_norm, away_norm)
            )
            self._exact.setdefault(key, event_id)
            return MatchResult(event_id, swapped=swapped, created=False, score=score)

        event_id = make_event_id(sport, home_norm, away_norm, dkey)
        canonical = CanonicalEvent(
            event_id=event_id,
            sport=sport,
            home_norm=home_norm,
            away_norm=away_norm,
            home=home,
            away=away,
            date_key=dkey,
            providers={provider} if provider else set(),
        )
        self._by_id[event_id] = canonical
        self._buckets.setdefault((sport, dkey), []).append(event_id)
        self._exact[exact_key] = event_id
        return MatchResult(event_id, swapped=False, created=True)

    def get(self, event_id: str) -> CanonicalEvent | None:
        return self._by_id.get(event_id)

    def __len__(self) -> int:
        return len(self._by_id)

    # -------------------------------------------------------------- intern
    def _candidate_ids(self, sport: Sport, start_time: datetime | None):
        keys: list[str] = []
        if start_time is None:
            keys = [k[1] for k in self._buckets if k[0] is sport]
        else:
            day = start_time.date()
            keys = [(day + timedelta(days=offset)).isoformat() for offset in (-1, 0, 1)] + [
                "unknown"
            ]
        seen: set[str] = set()
        for dkey in keys:
            for event_id in self._buckets.get((sport, dkey), ()):
                if event_id not in seen:
                    seen.add(event_id)
                    yield event_id


# ------------------------------------------------------ Markt/Selektion spiegeln

_FLIP_SELECTION: dict[SelectionCode, SelectionCode] = {
    SelectionCode.HOME: SelectionCode.AWAY,
    SelectionCode.AWAY: SelectionCode.HOME,
    SelectionCode.HOME_OR_DRAW: SelectionCode.AWAY_OR_DRAW,
    SelectionCode.AWAY_OR_DRAW: SelectionCode.HOME_OR_DRAW,
}

_SIGNED_LINE_MARKETS = {
    MarketType.ASIAN_HANDICAP,
    MarketType.HANDICAP,
    MarketType.GAME_HANDICAP,
    MarketType.SET_HANDICAP,
}


def flip_selection(selection: Selection) -> Selection:
    """Heim/Auswärts spiegeln (bei umgekehrter Team-Reihenfolge des Providers)."""
    flipped = _FLIP_SELECTION.get(selection.code)
    if flipped is None:
        return selection
    return Selection(code=flipped, label=selection.label, raw=selection.raw)


def flip_market(market: MarketKey) -> MarketKey:
    """Handicap-Linie spiegeln; Totals bleiben unverändert."""
    if market.type in _SIGNED_LINE_MARKETS and market.line is not None:
        return MarketKey(type=market.type, line=-market.line, period=market.period)
    return market


# ------------------------------------------------------ Rohtext -> Selektion

_OVER_WORDS = {"over", "o", "more", "ueber", "über", "mehr", "plus"}
_UNDER_WORDS = {"under", "u", "less", "unter", "weniger", "minus"}
_DRAW_WORDS = {"draw", "tie", "x", "unentschieden", "remis"}
_YES_WORDS = {"yes", "ja", "gg", "btts yes", "both"}
_NO_WORDS = {"no", "nein", "ng"}


def normalize_selection(
    raw: str,
    *,
    sport: Sport,
    home: str,
    away: str,
    market_type: MarketType,
) -> Selection:
    """Rohes Provider-Label auf einen normalisierten Selektionscode abbilden.

    Erkennt nichts Passendes, wird ``SelectionCode.OTHER`` mit Rohwert
    zurückgegeben - der Wert wird nicht geraten.
    """
    text = basic_clean(raw)
    if not text:
        return Selection(code=SelectionCode.OTHER, label=raw, raw=raw)

    first = text.split(" ")[0]
    if market_type in (MarketType.BTTS,):
        if text in _YES_WORDS or first in _YES_WORDS:
            return Selection(code=SelectionCode.YES, label="Yes", raw=raw)
        if text in _NO_WORDS or first in _NO_WORDS:
            return Selection(code=SelectionCode.NO, label="No", raw=raw)

    if first in _OVER_WORDS:
        return Selection(code=SelectionCode.OVER, label=raw.strip(), raw=raw)
    if first in _UNDER_WORDS:
        return Selection(code=SelectionCode.UNDER, label=raw.strip(), raw=raw)
    if text in _DRAW_WORDS:
        return Selection(code=SelectionCode.DRAW, label="Draw", raw=raw)

    if text in {"1", "home"}:
        return Selection(code=SelectionCode.HOME, label=home, raw=raw)
    if text in {"2", "away"}:
        return Selection(code=SelectionCode.AWAY, label=away, raw=raw)
    if text in {"1x", "home or draw"}:
        return Selection(code=SelectionCode.HOME_OR_DRAW, label=f"{home} / Draw", raw=raw)
    if text in {"x2", "away or draw", "draw or away"}:
        return Selection(code=SelectionCode.AWAY_OR_DRAW, label=f"Draw / {away}", raw=raw)
    if text in {"12", "home or away"}:
        return Selection(code=SelectionCode.HOME_OR_AWAY, label=f"{home} / {away}", raw=raw)

    norm_raw = normalize_participant(sport, raw)
    home_norm = normalize_participant(sport, home)
    away_norm = normalize_participant(sport, away)
    if norm_raw and similarity(norm_raw, home_norm) >= 0.85:
        return Selection(code=SelectionCode.HOME, label=home, raw=raw)
    if norm_raw and similarity(norm_raw, away_norm) >= 0.85:
        return Selection(code=SelectionCode.AWAY, label=away, raw=raw)

    return Selection(code=SelectionCode.OTHER, label=raw.strip(), raw=raw)


def parse_line(raw: str | float | None) -> float | None:
    """Linie ("2.5", "-0.25", "+1") robust einlesen."""
    if raw is None or raw == "":
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    text = str(raw).strip().replace("+", "")
    try:
        return float(text)
    except ValueError:
        return None


def period_for_set(set_number: int | None) -> Period:
    mapping = {
        1: Period.SET_1,
        2: Period.SET_2,
        3: Period.SET_3,
        4: Period.SET_4,
        5: Period.SET_5,
    }
    return mapping.get(set_number or 0, Period.CURRENT_SET)
