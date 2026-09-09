"""Empfehlung: was von alldem soll man tatsächlich spielen?

Ein Alarm sagt nur *hier stimmt etwas nicht*. Die Frage danach ist eine
andere: **spielen oder nicht - und mit wie viel?** Dieses Modul beantwortet
sie, und zwar bewusst nicht so, wie es naheliegt.

Naheliegend wäre: nach Value absteigend sortieren, oben steht die beste
Wette. Genau das ist falsch. Eine Quote, die 250 % über dem Markt liegt, ist
so gut wie nie ein Vorteil, sondern ein Datenfehler - eine andere Linie, ein
stehengebliebener Preis, ein Markt, der nur so heißt wie unserer. Wer nach
Value sortiert, sortiert die Datenfehler nach oben und schickt sich selbst
in die schlechtesten Wetten.

Deshalb gilt hier: **je größer die gemeldete Abweichung, desto stärker der
Verdacht auf einen Fehler statt auf einen Vorteil.** Der glaubwürdige
Vorteil (``credible_edge_percent``) steigt zunächst mit der Abweichung, hat
ein Maximum und fällt danach wieder gegen null. Das ist keine Willkür,
sondern das übliche Verhalten robuster Schätzer bei schwerschwänzigen
Fehlern (redeszendierende Einflussfunktion): ab einem gewissen Abstand ist
ein weiterer Schritt weg vom Markt kein Argument mehr *für* die Wette,
sondern eines *dagegen*.

Rechenweg für einen Alarm:

1. **Rohvorteil** ``value_percent`` - was das Modell behauptet.
2. **Verlässlichkeit** ``w_zuverlaessig`` aus Buchmacheranzahl, Confidence
   und Alter der Quote (jeweils gedeckelt, siehe unten).
3. **Plausibilität** ``w_plausibel = exp(-0.5 * (roh / skala)^2)`` - die
   redeszendierende Stufe. ``skala`` ist bei belegten Fehlpreisen größer:
   ein Alarm mit hohem Error-Score darf weiter vom Markt weg liegen.
4. **Glaubwürdiger Vorteil** = roh * w_zuverlaessig * w_plausibel.
5. **Einsatz** über fraktionales Kelly auf genau diesen Vorteil - nie auf
   den Rohwert. Gedeckelt, gerundet, und in Prozent der Bankroll.

Ehrlichkeitshinweis, der auch in der README steht: das ist eine Schätzung
aus öffentlich abrufbaren Quoten, **keine Wettberatung und keine
Gewinngarantie**. Das System setzt nichts - es rechnet und zeigt an. Ob
gespielt wird, entscheidet der Mensch am Ende der Kette.
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field, replace
from enum import StrEnum
from typing import TYPE_CHECKING, Any

from backend.models.domain import Alert, now_ts
from backend.models.enums import AlertKind, EventStatus

if TYPE_CHECKING:  # pragma: no cover - nur für Typprüfer
    from backend.core.config import Settings


class Grade(StrEnum):
    """Wie deutlich die Empfehlung ausfällt."""

    #: Klarer Fall: genug Referenzen, plausible Größe, frischer Preis.
    STRONG = "strong"
    #: Spielbar, aber kleiner - eine der Stützen ist schwach.
    MODERATE = "moderate"
    #: Rest-Vorteil zu dünn für einen Einsatz. Beobachten, nicht spielen.
    WEAK = "weak"
    #: Nicht spielen. Der Grund steht in ``reason_code``.
    SKIP = "skip"


GRADE_LABELS: dict[str, str] = {
    Grade.STRONG: "Spielen",
    Grade.MODERATE: "Kleiner Einsatz",
    Grade.WEAK: "Nur beobachten",
    Grade.SKIP: "Nicht spielen",
}

#: Grade, für die ein Einsatz vorgeschlagen wird.
PLAYABLE_GRADES: frozenset[Grade] = frozenset({Grade.STRONG, Grade.MODERATE})

#: Stabile Codes für „warum nicht spielen" - wie bei den Unterdrückungs-
#: gründen des Scanners: maschinenlesbar zählbar, nicht nur schöner Text.
REASON_LABELS: dict[str, str] = {
    "ok": "spielbar",
    "keine_referenz": "Bewegungsalarm ohne faire Quote - nichts zu bewerten",
    "kein_vorteil": "kein Vorteil gegenüber dem Markt",
    "unplausibel": "Vorteil unplausibel groß - fast immer ein Datenfehler",
    "confidence_zu_niedrig": "Referenz zu unsicher",
    "zu_wenige_buchmacher": "zu wenige Vergleichsquoten",
    "quote_zu_alt": "Quote zu alt - Preis womöglich nicht mehr da",
    "markt_gesperrt": "Markt gesperrt oder Event beendet",
    "rest_zu_klein": "nach Abzug der Unsicherheit bleibt zu wenig übrig",
    "einsatz_zu_klein": "rechnerischer Einsatz unter der Mindestgröße",
    "budget_erschoepft": "Einsatzbudget der Liste bereits ausgeschöpft",
    "doppelt": "gleiche Wette bereits in der Liste (besserer Preis behalten)",
    "event_belegt": "für dieses Event steht schon eine bessere Wette",
    "liste_voll": "Liste bereits voll - schwächere Empfehlung ausgelassen",
    "alarm_unlesbar": "gespeicherter Alarm nicht lesbar - übersprungen",
    "alarm_veraltet": "Alarm zu alt - der Preis steht so nicht mehr",
}


@dataclass(slots=True)
class RecommendationConfig:
    """Stellschrauben der Empfehlung."""

    # ------------------------------------------------------- Einsatzgröße
    #: Anteil des vollen Kelly-Einsatzes. Voller Kelly ist theoretisch
    #: optimal und praktisch unbrauchbar: er unterstellt, die geschätzte
    #: Wahrscheinlichkeit sei exakt. Ein Viertel ist der übliche Kompromiss.
    kelly_fraction: float = 0.25
    #: Obergrenze je Wette, in Prozent der Bankroll.
    max_stake_percent: float = 2.0
    #: Darunter lohnt der Aufwand nicht - dann lieber gar nicht.
    min_stake_percent: float = 0.1
    #: Obergrenze über die ganze Empfehlungsliste.
    max_total_stake_percent: float = 6.0
    #: Optional: Bankroll in Kontowährung. 0 = unbekannt, dann wird nur der
    #: Prozentsatz genannt und kein Betrag erfunden.
    bankroll: float = 0.0

    # ------------------------------------------------------ Plausibilität
    #: Größenordnung eines Vorteils, den es wirklich geben kann (in %).
    plausible_edge_percent: float = 8.0
    #: Obergrenze derselben Skala bei voll belegtem Fehlpreis.
    max_plausible_edge_percent: float = 18.0
    #: Darüber wird ohne Rechnung abgelehnt.
    absurd_edge_percent: float = 60.0

    # --------------------------------------------------------- Mindestmaß
    min_confidence: int = 65
    min_bookmakers: int = 4
    max_odds_age: float = 15.0

    # ------------------------------------------------------------- Grade
    strong_edge_percent: float = 3.0
    moderate_edge_percent: float = 1.5
    weak_edge_percent: float = 0.5
    strong_confidence: int = 75
    moderate_confidence: int = 65

    # ------------------------------------------------------------ Liste
    #: Wie viele Wetten je Event höchstens. Zwei Selektionen desselben
    #: Spiels hängen zusammen - im Extremfall schließen sie einander aus.
    max_picks_per_event: int = 1
    #: Ab diesem Alter ist ein Alarm keine Empfehlung mehr, sondern
    #: Geschichte. Live-Quoten stehen keine Viertelstunde, und ein beendetes
    #: Spiel meldet sein Ende nicht - es hört nur auf zu erscheinen.
    max_alert_age: float = 180.0


def config_from_settings(settings: Settings) -> RecommendationConfig:
    """Konfiguration aus den Umgebungseinstellungen bauen."""
    return RecommendationConfig(
        kelly_fraction=settings.kelly_fraction,
        max_stake_percent=settings.max_stake_percent,
        max_total_stake_percent=settings.max_total_stake_percent,
        bankroll=settings.bankroll,
        plausible_edge_percent=settings.plausible_edge_percent,
        max_plausible_edge_percent=settings.max_plausible_edge_percent,
        absurd_edge_percent=settings.absurd_edge_percent,
        min_confidence=settings.recommend_min_confidence,
        min_bookmakers=settings.recommend_min_bookmakers,
        max_odds_age=settings.recommend_max_odds_age,
        max_picks_per_event=settings.recommend_max_picks_per_event,
        max_alert_age=settings.event_stale_seconds,
    )


@dataclass(slots=True)
class Calculation:
    """Die ausgeschriebene Rechnung zu einer Empfehlung.

    Prozentwerte allein beantworten die Frage nicht, die man sich vor dem
    Setzen stellt: *was kostet das, was kommt zurück, und wie oft muss ich
    recht behalten?* Alles hier folgt exakt aus Quote, Einsatz und dem
    glaubwürdigen Vorteil - es wird nichts geraten und nichts gerundet, was
    die Aussage verschiebt.

    Ohne hinterlegte Bankroll bleiben die Beträge ``None``: einen Einsatz in
    Euro zu nennen, den niemand festgelegt hat, wäre eine erfundene Zahl.
    """

    #: Was der Buchmacher mit seiner Quote behauptet: 1 / Quote.
    implied_probability: float
    #: Was wir nach Abzug aller Unsicherheit annehmen: (1 + Vorteil) / Quote.
    credible_probability: float
    #: Trefferquote, ab der die Wette bei dieser Quote aufgeht - dieselbe
    #: Zahl wie die implizite Wahrscheinlichkeit, nur anders gelesen.
    break_even_percent: float
    #: Erwartungswert je eingesetzter Einheit, in Prozent.
    expected_value_percent: float
    #: Nettogewinn je eingesetzter Einheit, wenn die Wette aufgeht.
    profit_per_unit: float
    # ------------------------------------------------ nur mit Bankroll
    stake_amount: float | None = None
    payout_amount: float | None = None
    profit_amount: float | None = None
    expected_value_amount: float | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "implied_probability": round(self.implied_probability, 4),
            "credible_probability": round(self.credible_probability, 4),
            "break_even_percent": round(self.break_even_percent, 2),
            "expected_value_percent": round(self.expected_value_percent, 2),
            "profit_per_unit": round(self.profit_per_unit, 3),
            "stake_amount": _round_money(self.stake_amount),
            "payout_amount": _round_money(self.payout_amount),
            "profit_amount": _round_money(self.profit_amount),
            "expected_value_amount": _round_money(self.expected_value_amount),
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> Calculation:
        return cls(
            implied_probability=float(data.get("implied_probability", 0.0)),
            credible_probability=float(data.get("credible_probability", 0.0)),
            break_even_percent=float(data.get("break_even_percent", 0.0)),
            expected_value_percent=float(data.get("expected_value_percent", 0.0)),
            profit_per_unit=float(data.get("profit_per_unit", 0.0)),
            stake_amount=data.get("stake_amount"),
            payout_amount=data.get("payout_amount"),
            profit_amount=data.get("profit_amount"),
            expected_value_amount=data.get("expected_value_amount"),
        )


def _round_money(value: float | None) -> float | None:
    return round(value, 2) if value is not None else None


def calculate(
    *, odds: float, credible_edge_percent: float, stake_percent: float, bankroll: float = 0.0
) -> Calculation:
    """Die Rechnung zu einer Empfehlung ausschreiben."""
    implied = 1.0 / odds if odds > 0 else 0.0
    credible = implied * (1.0 + credible_edge_percent / 100.0)
    stake = bankroll * stake_percent / 100.0 if bankroll > 0 and stake_percent > 0 else None
    return Calculation(
        implied_probability=implied,
        credible_probability=credible,
        break_even_percent=implied * 100.0,
        expected_value_percent=credible_edge_percent,
        profit_per_unit=max(0.0, odds - 1.0),
        stake_amount=stake,
        payout_amount=stake * odds if stake else None,
        profit_amount=stake * (odds - 1.0) if stake else None,
        expected_value_amount=stake * credible_edge_percent / 100.0 if stake else None,
    )


@dataclass(slots=True)
class Recommendation:
    """Was mit einem Alarm zu tun ist."""

    grade: Grade
    #: Warum dieser Grad - Code aus ``REASON_LABELS``.
    reason_code: str
    #: Der Vorteil, den man nach Abzug aller Unsicherheit noch annehmen darf.
    credible_edge_percent: float
    #: Was das Modell roh behauptet hat (zum Vergleich, nicht zum Rechnen).
    raw_edge_percent: float
    #: Vorgeschlagener Einsatz in Prozent der Bankroll (0 = nicht spielen).
    stake_percent: float = 0.0
    #: Betrag in Kontowährung - nur wenn eine Bankroll hinterlegt ist.
    stake_amount: float | None = None
    #: Die beiden Abschläge, damit die Zahl nachvollziehbar bleibt.
    reliability: float = 0.0
    plausibility: float = 0.0
    #: Sortiergröße der Empfehlungsliste.
    rank_score: float = 0.0
    #: Was dafür spricht.
    reasons: list[str] = field(default_factory=list)
    #: Was dagegen spricht - steht auch bei „Spielen" dabei.
    warnings: list[str] = field(default_factory=list)
    #: Vor dem Setzen selbst zu prüfen. Der Bot setzt nichts.
    checklist: list[str] = field(default_factory=list)
    #: Ein Satz: was genau man spielen würde.
    play: str = ""
    #: Die ausgeschriebene Rechnung. ``None`` bei allem, was nicht gespielt
    #: wird - dort gibt es nichts auszurechnen.
    math: Calculation | None = None

    @property
    def label(self) -> str:
        return GRADE_LABELS.get(self.grade, self.grade.value)

    @property
    def reason_label(self) -> str:
        return REASON_LABELS.get(self.reason_code, self.reason_code)

    @property
    def playable(self) -> bool:
        return self.grade in PLAYABLE_GRADES and self.stake_percent > 0.0

    def to_json(self) -> dict[str, Any]:
        return {
            "grade": self.grade.value,
            "label": self.label,
            "reason_code": self.reason_code,
            "reason_label": self.reason_label,
            "credible_edge_percent": round(self.credible_edge_percent, 2),
            "raw_edge_percent": round(self.raw_edge_percent, 2),
            "stake_percent": round(self.stake_percent, 2),
            "stake_amount": (round(self.stake_amount, 2) if self.stake_amount else None),
            "reliability": round(self.reliability, 3),
            "plausibility": round(self.plausibility, 3),
            "rank_score": round(self.rank_score, 3),
            "reasons": list(self.reasons),
            "warnings": list(self.warnings),
            "checklist": list(self.checklist),
            "play": self.play,
            "math": self.math.to_json() if self.math else None,
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> Recommendation:
        return cls(
            grade=Grade(data.get("grade", Grade.SKIP)),
            reason_code=data.get("reason_code", "ok"),
            credible_edge_percent=float(data.get("credible_edge_percent", 0.0)),
            raw_edge_percent=float(data.get("raw_edge_percent", 0.0)),
            stake_percent=float(data.get("stake_percent", 0.0)),
            stake_amount=data.get("stake_amount"),
            reliability=float(data.get("reliability", 0.0)),
            plausibility=float(data.get("plausibility", 0.0)),
            rank_score=float(data.get("rank_score", 0.0)),
            reasons=list(data.get("reasons", [])),
            warnings=list(data.get("warnings", [])),
            checklist=list(data.get("checklist", [])),
            play=data.get("play", ""),
            math=Calculation.from_json(data["math"]) if data.get("math") else None,
        )


# --------------------------------------------------------------- Abschläge


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def reliability_weight(
    *, bookmaker_count: int, confidence: int, odds_age: float, config: RecommendationConfig
) -> tuple[float, list[str]]:
    """Wie belastbar ist die Referenz? Drei Faktoren, jeder mit Boden.

    Der Boden ist Absicht: die harten Mindestwerte lehnen ohnehin schon ab.
    Was hier durchkommt, soll abgestuft und nicht rechnerisch vernichtet
    werden.
    """
    notes: list[str] = []

    # Marktbreite: acht unabhängige Bücher gelten als volle Referenz.
    span = math.log2(1.0 + max(0, bookmaker_count)) / math.log2(9.0)
    w_books = _clamp(span, 0.5, 1.0)
    if bookmaker_count < 8:
        notes.append(f"nur {bookmaker_count} Vergleichsquoten")

    # Confidence der Value Engine, linear von 30 auf 90.
    w_conf = _clamp((confidence - 30.0) / 60.0, 0.4, 1.0)
    if confidence < 75:
        notes.append(f"Confidence {confidence}/100")

    # Alter: bei Erreichen des Limits bleibt die Hälfte übrig.
    ratio = odds_age / max(config.max_odds_age, 0.1)
    w_age = _clamp(1.0 - 0.5 * min(1.0, ratio), 0.6, 1.0)
    if odds_age > config.max_odds_age / 2.0:
        notes.append(f"Quote {odds_age:.0f}s alt")

    return w_books * w_conf * w_age, notes


def plausibility_scale(*, kind: AlertKind, error_score: int, config: RecommendationConfig) -> float:
    """Wie weit darf ein Preis vom Markt weg sein, ohne verdächtig zu sein?

    Für einen belegten Fehlpreis mehr als für „nur" Value: bei einem
    Fehlpreis ist die Behauptung ja gerade, dass dieses eine Buch danebenliegt
    - und der Error-Score sagt, wie gut sie belegt ist.
    """
    base = config.plausible_edge_percent
    if kind is not AlertKind.FIXED_ERROR:
        return base
    reach = max(0.0, config.max_plausible_edge_percent - base)
    return base + reach * _clamp(error_score / 100.0, 0.0, 1.0)


def plausibility_weight(raw_edge_percent: float, scale: float) -> float:
    """Redeszendierendes Gewicht: groß ist gut, sehr groß ist verdächtig.

    ``exp(-0.5 * (x/s)^2)``. Bei ``x = s`` bleiben rund 61 % stehen, bei
    ``x = 2s`` noch 14 %, bei ``x = 3s`` praktisch nichts. Genau deshalb
    steht ein 200-%-„Value" nie oben in der Liste.
    """
    if scale <= 0:
        return 0.0
    return math.exp(-0.5 * (raw_edge_percent / scale) ** 2)


def kelly_stake_percent(
    *, odds: float, credible_edge_percent: float, config: RecommendationConfig
) -> float:
    """Fraktionaler Kelly-Einsatz in Prozent der Bankroll.

    Mit ``p`` als der Wahrscheinlichkeit, die bei diesen Quoten genau den
    glaubwürdigen Vorteil ergibt, kürzt sich der volle Kelly-Anteil zu
    ``edge / (odds - 1)``. Der Bruchteil und der Deckel kommen danach.
    """
    if odds <= 1.0 or credible_edge_percent <= 0.0:
        return 0.0
    full = (credible_edge_percent / 100.0) / (odds - 1.0)
    staked = 100.0 * config.kelly_fraction * full
    return min(config.max_stake_percent, staked)


# ------------------------------------------------------------- Hauptfunktion


def _skip(
    code: str, *, raw: float, credible: float = 0.0, reliability: float = 0.0, plaus: float = 0.0
) -> Recommendation:
    return Recommendation(
        grade=Grade.SKIP,
        reason_code=code,
        credible_edge_percent=credible,
        raw_edge_percent=raw,
        reliability=reliability,
        plausibility=plaus,
        warnings=[REASON_LABELS.get(code, code)],
    )


def _play_text(alert: Alert, stake_percent: float, config: RecommendationConfig) -> str:
    bet = (
        f"{alert.event.title} - {alert.market.label}: {alert.selection.display} "
        f"bei {alert.bookmaker} zu {alert.odds:.2f}"
    )
    if stake_percent <= 0:
        return bet
    if config.bankroll > 0:
        amount = config.bankroll * stake_percent / 100.0
        return f"{bet} - Einsatz {stake_percent:.1f} % ({amount:.2f})"
    return f"{bet} - Einsatz {stake_percent:.1f} % der Bankroll"


def evaluate(alert: Alert, config: RecommendationConfig | None = None) -> Recommendation:
    """Aus einem Alarm eine Handlungsempfehlung machen."""
    cfg = config or RecommendationConfig()
    raw = alert.value_percent

    # Bewegungsalarme haben keine faire Quote - ``fair_odds`` trägt dort den
    # vorherigen Preis. Daraus einen Vorteil abzuleiten wäre erfunden.
    if alert.kind is AlertKind.ODDS_MOVE:
        return _skip("keine_referenz", raw=0.0)

    if alert.event.status in (EventStatus.FINISHED, EventStatus.SUSPENDED):
        return _skip("markt_gesperrt", raw=raw)
    if raw <= 0.0:
        return _skip("kein_vorteil", raw=raw)
    if raw >= cfg.absurd_edge_percent:
        return _skip("unplausibel", raw=raw)
    if alert.bookmaker_count < cfg.min_bookmakers:
        return _skip("zu_wenige_buchmacher", raw=raw)
    if alert.confidence < cfg.min_confidence:
        return _skip("confidence_zu_niedrig", raw=raw)
    if alert.odds_age > cfg.max_odds_age:
        return _skip("quote_zu_alt", raw=raw)

    reliability, notes = reliability_weight(
        bookmaker_count=alert.bookmaker_count,
        confidence=alert.confidence,
        odds_age=alert.odds_age,
        config=cfg,
    )
    scale = plausibility_scale(kind=alert.kind, error_score=alert.error_score, config=cfg)
    plausibility = plausibility_weight(raw, scale)
    credible = raw * reliability * plausibility

    warnings = list(notes)
    # Erst warnen, wenn die Schrumpfung wirklich etwas ändert. Beide Zahlen
    # stehen ohnehin nebeneinander ("Vorteil +3.3 %, gemeldet +11.0 %") -
    # eine Warnung an jedem einzelnen Eintrag wäre Tapete, und Tapete liest
    # niemand mehr, wenn es einmal wirklich darauf ankommt.
    if plausibility < 0.25:
        warnings.append(
            f"gemeldete {raw:.0f} % sind größer als real erreichbare Vorteile "
            f"- gerechnet wird mit {credible:.1f} %"
        )

    if credible < cfg.weak_edge_percent:
        rec = _skip(
            "rest_zu_klein",
            raw=raw,
            credible=credible,
            reliability=reliability,
            plaus=plausibility,
        )
        rec.warnings = [*warnings, rec.warnings[0]]
        return rec

    stake = kelly_stake_percent(odds=alert.odds, credible_edge_percent=credible, config=cfg)

    if credible >= cfg.strong_edge_percent and alert.confidence >= cfg.strong_confidence:
        grade = Grade.STRONG
    elif credible >= cfg.moderate_edge_percent and alert.confidence >= cfg.moderate_confidence:
        grade = Grade.MODERATE
    else:
        grade = Grade.WEAK

    if grade in PLAYABLE_GRADES and stake < cfg.min_stake_percent:
        # Rechnerisch positiv, praktisch belanglos - vor allem bei hohen
        # Quoten, wo Kelly den Einsatz zu Recht zusammenstreicht.
        rec = _skip(
            "einsatz_zu_klein",
            raw=raw,
            credible=credible,
            reliability=reliability,
            plaus=plausibility,
        )
        rec.warnings = [*warnings, rec.warnings[0]]
        return rec
    if grade is Grade.WEAK:
        stake = 0.0

    reasons = [
        f"glaubwürdiger Vorteil {credible:.1f} % (gemeldet {raw:.1f} %)",
        f"{alert.bookmaker_count} Vergleichsquoten, Confidence {alert.confidence}/100",
    ]
    if alert.kind is AlertKind.FIXED_ERROR:
        reasons.append(f"Fehlpreis-Score {alert.error_score}/100")

    checklist = [
        "Preis beim Buchmacher selbst prüfen - er kann schon weg sein",
        "Markt und Linie vergleichen, nicht nur den Namen",
        "Einsatzlimit des Buchmachers beachten",
    ]
    if alert.event.is_live:
        checklist.append("Live: Spielstand prüfen, die Quote gilt für die Lage von eben")

    stake = round(stake, 2)
    amount = round(cfg.bankroll * stake / 100.0, 2) if cfg.bankroll > 0 and stake > 0 else None
    math = calculate(
        odds=alert.odds,
        credible_edge_percent=credible,
        stake_percent=stake,
        bankroll=cfg.bankroll,
    )

    return Recommendation(
        grade=grade,
        reason_code="ok",
        credible_edge_percent=credible,
        raw_edge_percent=raw,
        stake_percent=stake,
        stake_amount=amount,
        reliability=reliability,
        plausibility=plausibility,
        rank_score=credible * (alert.confidence / 100.0),
        reasons=reasons,
        warnings=warnings,
        checklist=checklist,
        play=_play_text(alert, stake, cfg),
        math=math,
    )


# ------------------------------------------------------------------- Liste


@dataclass(slots=True)
class Pick:
    """Ein Alarm mit seiner Empfehlung."""

    alert: Alert
    recommendation: Recommendation

    def to_json(self) -> dict[str, Any]:
        return {"alert": self.alert.to_json(), "recommendation": self.recommendation.to_json()}


@dataclass(slots=True)
class Slip:
    """Die fertige Liste: was man jetzt spielen würde.

    ``dropped`` ist wichtiger, als es aussieht. Eine leere Liste ohne Grund
    ist der Fehler, der einen Nutzer ratlos vor dem Bildschirm sitzen lässt.
    Hier steht deshalb immer, warum nichts übrig blieb.
    """

    picks: list[Pick] = field(default_factory=list)
    considered: int = 0
    total_stake_percent: float = 0.0
    dropped: Counter[str] = field(default_factory=Counter)

    def to_json(self) -> dict[str, Any]:
        return {
            "picks": [pick.to_json() for pick in self.picks],
            "considered": self.considered,
            "total_stake_percent": round(self.total_stake_percent, 2),
            "dropped": [
                {"code": code, "label": REASON_LABELS.get(code, code), "count": count}
                for code, count in self.dropped.most_common()
            ],
        }


def _with_stake(
    alert: Alert, rec: Recommendation, stake: float, config: RecommendationConfig
) -> Recommendation:
    """Kopie mit dem tatsächlich vorgeschlagenen Einsatz.

    Betrag und Klartext werden hier **immer** neu gebildet, nicht nur beim
    Kürzen. Grund: eine gespeicherte Empfehlung stammt aus dem Moment des
    Alarms - wer erst danach eine Bankroll hinterlegt, bekäme sonst für
    immer nur Prozentwerte zu sehen.
    """
    stake = round(stake, 2)
    gekuerzt = stake < rec.stake_percent - 1e-9
    amount = round(config.bankroll * stake / 100.0, 2) if config.bankroll > 0 else None
    warnings = (
        [*rec.warnings, "Einsatz wegen des Gesamtbudgets gekürzt"] if gekuerzt else rec.warnings
    )
    return replace(
        rec,
        stake_percent=stake,
        stake_amount=amount,
        warnings=warnings,
        play=_play_text(alert, stake, config),
        # Die Rechnung hängt am Einsatz - eine stehengebliebene Auszahlung
        # zu einem gekürzten Einsatz wäre schlicht falsch.
        math=calculate(
            odds=alert.odds,
            credible_edge_percent=rec.credible_edge_percent,
            stake_percent=stake,
            bankroll=config.bankroll,
        ),
    )


def build_slip(
    pairs: Iterable[tuple[Alert, Recommendation]],
    *,
    config: RecommendationConfig | None = None,
    limit: int = 10,
    reference: float | None = None,
) -> Slip:
    """Aus vielen Alarmen eine widerspruchsfreie Liste machen.

    Drei Regeln, alle aus demselben Grund - Alarme sind nicht unabhängig:

    * **Gleiche Wette nur einmal**, und zwar zum höchsten Preis. Für
      *dieselbe* Selektion ist das keine Schätzung, sondern Arithmetik:
      2.20 schlägt 2.10, immer. Die Plausibilitätsfrage ist an dieser
      Stelle schon beantwortet - unspielbare Quoten fliegen vorher raus,
      und wenn der extreme Preis als Datenfehler ausscheidet, bleibt der
      maßvollere übrig statt dass beide verschwinden.
    * **Höchstens ``max_picks_per_event`` Wetten je Event.** Zwei
      Selektionen desselben Spiels hängen zusammen; im Extremfall würde die
      Liste sonst Über *und* Unter empfehlen.
    * **Gesamtbudget.** Zehn gute Wetten sind nicht zehnmal so sicher wie
      eine - sie sind nur zehnmal so viel Einsatz.

    Dazu die Frist: ein Alarm von vor einer Viertelstunde ist keine
    Empfehlung mehr. Live-Quoten stehen nicht so lange, und ein beendetes
    Spiel meldet sein Ende nicht - es hört einfach auf zu erscheinen. Ohne
    diese Grenze stünde die Wette auf ein längst fertiges Match noch oben in
    der Liste.
    """
    cfg = config or RecommendationConfig()
    ref = reference if reference is not None else now_ts()
    slip = Slip()
    best: dict[tuple[str, str, str], Pick] = {}

    for alert, rec in pairs:
        slip.considered += 1
        if cfg.max_alert_age > 0 and (ref - alert.detected_at) > cfg.max_alert_age:
            slip.dropped["alarm_veraltet"] += 1
            continue
        if not rec.playable:
            code = rec.reason_code if rec.grade is Grade.SKIP else "rest_zu_klein"
            slip.dropped[code] += 1
            continue
        key = (alert.event.event_id, alert.market.key, alert.selection.key)
        current = best.get(key)
        if current is None:
            best[key] = Pick(alert, rec)
            continue
        slip.dropped["doppelt"] += 1
        if alert.odds > current.alert.odds:
            best[key] = Pick(alert, rec)

    per_event: Counter[str] = Counter()
    budget = cfg.max_total_stake_percent
    ordered = sorted(best.values(), key=lambda p: p.recommendation.rank_score, reverse=True)

    for pick in ordered:
        if len(slip.picks) >= limit:
            slip.dropped["liste_voll"] += 1
            continue
        event_id = pick.alert.event.event_id
        if per_event[event_id] >= cfg.max_picks_per_event:
            slip.dropped["event_belegt"] += 1
            continue
        stake = min(pick.recommendation.stake_percent, budget)
        if stake < cfg.min_stake_percent:
            slip.dropped["budget_erschoepft"] += 1
            continue
        recommendation = _with_stake(pick.alert, pick.recommendation, stake, cfg)
        slip.picks.append(Pick(pick.alert, recommendation))
        per_event[event_id] += 1
        budget -= recommendation.stake_percent
        slip.total_stake_percent += recommendation.stake_percent

    slip.total_stake_percent = round(slip.total_stake_percent, 2)
    return slip


def recommend_all(
    alerts: Iterable[Alert], *, config: RecommendationConfig | None = None, limit: int = 10
) -> Slip:
    """Bequemlichkeit: bewerten und gleich zur Liste zusammenfassen."""
    cfg = config or RecommendationConfig()
    return build_slip(((alert, evaluate(alert, cfg)) for alert in alerts), config=cfg, limit=limit)
