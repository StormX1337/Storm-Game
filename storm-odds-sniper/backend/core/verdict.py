"""Nachverfolgung: was ist aus einem Alarm geworden?

Ein Alarm ist eine Behauptung: *dieser Preis ist besser als der Markt*. Ohne
Nachkontrolle bleibt sie unüberprüft - das System meldet, und niemand weiß, ob
die Meldungen etwas taugen. Dieses Modul schließt den Kreis, und zwar nur mit
Daten, die ohnehin schon einlaufen: kein einziger zusätzlicher API-Aufruf.

Nach einer Wartezeit wird derselbe Preis erneut betrachtet::

    Alarm:   Bookie 3.80   fair 2.45   (+55 %)
    Später:  Bookie 2.50   fair 2.47

    -> die Lücke ist zu, und zwar weil der Buchmacher gefallen ist.
       Urteil: "korrigiert" - der Fehlpreis war echt und ist weg.

Gegenbeispiel::

    Alarm:   Bookie 3.80   fair 2.45
    Später:  Bookie 3.85   fair 3.70

    -> die Lücke ist ebenfalls zu, aber der *Markt* ist gestiegen.
       Urteil: "Markt gefolgt" - der Buchmacher war schneller, nicht falsch.
       Ein Einsatz hätte hier keinen Vorteil gehabt.

Die zweite Kennzahl ist der **Closing Line Value** (CLV): um wie viel Prozent
lag der gemeldete Preis über der Quote, bei der der Markt zuletzt stand.
Positiver CLV ist der übliche Beleg dafür, dass ein Preis wirklich zu hoch war.

Ehrlichkeitshinweis, der auch in der README steht: CLV ist **kein** Gewinn.
Er misst nur, dass ein Preis besser war als der spätere Marktkonsens - nicht,
ob die Wette gewonnen hätte. Und der "Schlusskurs" ist hier immer nur der
zuletzt beobachtete Kurs; wer selten pollt, misst gegen eine grobe Referenz.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

#: Unterhalb dieser Preisdifferenz ist nichts passiert - Rundung und
#: Nachkommastellen der Buchmacher erzeugen sonst ständig Scheinbewegungen.
EPS = 1e-9


class Verdict(StrEnum):
    """Was aus einem Alarm geworden ist."""

    #: Der auffällige Buchmacher hat seinen Preis selbst nach unten gezogen.
    #: Der stärkste Beleg dafür, dass der Fehlpreis echt war.
    CORRECTED = "corrected"
    #: Der Markt ist zum gemeldeten Preis aufgestiegen - der Buchmacher war
    #: nur schneller. Kein Vorteil, aber auch kein Fehler des Buchmachers.
    MARKET_FOLLOWED = "market_followed"
    #: Nichts hat sich bewegt, der Preis steht noch.
    HELD = "held"
    #: Der Preis ist verschwunden oder gesperrt - typisch für echte
    #: Eingabefehler, die zurückgezogen werden.
    VANISHED = "vanished"
    #: Nur für Bewegungsalarme: der Sprung ist wieder zurückgelaufen.
    REVERTED = "reverted"
    #: Die Spielsituation hat sich geändert (Tor, Satz). Ein Vergleich mit
    #: der Quote von vorher wäre sinnlos - die wahre Wahrscheinlichkeit ist
    #: eine andere geworden.
    SUPERSEDED = "superseded"
    #: Keine Folgedaten. Wird nie als Erfolg gezählt.
    UNRESOLVED = "unresolved"


#: Urteile, die als Beleg für einen echt gefundenen Fehlpreis zählen.
POSITIVE_VERDICTS: frozenset[Verdict] = frozenset({Verdict.CORRECTED, Verdict.VANISHED})

VERDICT_LABELS: dict[str, str] = {
    Verdict.CORRECTED: "korrigiert - der Buchmacher hat den Preis selbst gesenkt",
    Verdict.MARKET_FOLLOWED: "Markt gefolgt - der Buchmacher war nur schneller",
    Verdict.HELD: "unverändert - der Preis steht noch",
    Verdict.VANISHED: "verschwunden - Preis zurückgezogen oder gesperrt",
    Verdict.REVERTED: "zurückgelaufen - die Bewegung hielt nicht",
    Verdict.SUPERSEDED: "überholt - der Spielstand hat sich geändert",
    Verdict.UNRESOLVED: "offen - keine Folgedaten",
}


@dataclass(slots=True)
class VerdictConfig:
    #: Ab dieser Änderung in Prozentpunkten gilt etwas als bewegt.
    move_percent: float = 2.0
    #: Anteil des Sprungs, ab dem eine Bewegung als zurückgelaufen gilt.
    revert_fraction: float = 0.5


@dataclass(slots=True)
class Resolution:
    """Das Ergebnis einer Nachkontrolle."""

    verdict: Verdict
    #: Gemeldeter Preis gegenüber der zuletzt beobachteten fairen Quote, in %.
    clv_percent: float | None = None
    #: Wie sich der gemeldete Buchmacher bewegt hat, in %.
    price_move_percent: float | None = None
    #: Wie sich der Marktkonsens bewegt hat, in %.
    market_move_percent: float | None = None
    #: Um wie viele Prozentpunkte sich die Auffälligkeit geschlossen hat.
    gap_closed_percent: float | None = None
    note: str = ""

    @property
    def label(self) -> str:
        return VERDICT_LABELS.get(self.verdict, self.verdict.value)

    @property
    def beat_the_close(self) -> bool | None:
        """Lag der gemeldete Preis über dem späteren Marktkonsens?"""
        if self.clv_percent is None:
            return None
        return self.clv_percent > 0.0

    def to_json(self) -> dict[str, object]:
        return {
            "verdict": self.verdict.value,
            "label": self.label,
            "clv_percent": _round(self.clv_percent),
            "price_move_percent": _round(self.price_move_percent),
            "market_move_percent": _round(self.market_move_percent),
            "gap_closed_percent": _round(self.gap_closed_percent),
            "note": self.note,
        }


def _round(value: float | None) -> float | None:
    return None if value is None else round(value, 2)


def _percent_change(before: float | None, after: float | None) -> float | None:
    if before is None or after is None or before <= EPS:
        return None
    return (after / before - 1.0) * 100.0


def resolve(
    *,
    kind: str,
    alert_odds: float,
    alert_fair: float,
    final_price: float | None,
    final_fair: float | None,
    previous_odds: float | None = None,
    suspended: bool = False,
    state_changed: bool = False,
    config: VerdictConfig | None = None,
) -> Resolution:
    """Ein Urteil aus Alarmzeitpunkt und Nachkontrolle ableiten.

    ``final_price`` ist ``None``, wenn der Buchmacher die Quote nicht mehr
    anbietet; ``final_fair`` ist ``None``, wenn der Markt insgesamt keine
    verwertbaren Vergleichspreise mehr hat.
    """
    cfg = config or VerdictConfig()

    # Eine Quote von 0 (oder negativ) gibt es nicht. Solche Werte entstehen nur
    # aus kaputten Daten und werden wie "nicht vorhanden" behandelt - sonst
    # teilt die Auswertung durch null.
    if final_price is not None and final_price <= EPS:
        final_price = None
    if final_fair is not None and final_fair <= EPS:
        final_fair = None
    if previous_odds is not None and previous_odds <= EPS:
        previous_odds = None
    if alert_odds <= EPS:
        return Resolution(Verdict.UNRESOLVED, note="Alarmpreis unbrauchbar")

    # Nach einem Tor oder einem Satz ist die Quote von vorher keine gültige
    # Vergleichsgröße mehr: nicht der Buchmacher hat sich geirrt, die Lage ist
    # eine andere. Ein CLV über eine solche Grenze hinweg wäre eine Fantasiezahl
    # (beobachtet: 43.66 -> 2.71, also "+1677 % Vorteil").
    if state_changed:
        return Resolution(
            Verdict.SUPERSEDED, note="Spielstand hat sich geändert - kein gültiger Vergleich"
        )

    if kind == "odds_move":
        return _resolve_move(alert_odds, final_price, previous_odds, suspended, cfg)

    clv = _percent_change(final_fair, alert_odds)
    price_move = _percent_change(alert_odds, final_price)
    market_move = _percent_change(alert_fair, final_fair)

    if final_price is None or suspended:
        if final_price is None and final_fair is None:
            return Resolution(Verdict.UNRESOLVED, note="keine Folgedaten beobachtet")
        return Resolution(
            Verdict.VANISHED,
            clv_percent=clv,
            market_move_percent=market_move,
            note="Quote wurde zurückgezogen oder gesperrt",
        )

    if final_fair is None:
        return Resolution(
            Verdict.UNRESOLVED,
            price_move_percent=price_move,
            note="kein Marktkonsens mehr - Vergleich nicht möglich",
        )

    # Die Auffälligkeit selbst ist der Abstand zwischen gemeldetem Preis und
    # fairer Quote. Ob er sich geschlossen hat, ist die eigentliche Frage.
    gap_before = (alert_odds / alert_fair - 1.0) * 100.0 if alert_fair > EPS else 0.0
    gap_after = (final_price / final_fair - 1.0) * 100.0
    closed = gap_before - gap_after

    def verdict_for(kind_: Verdict, note: str) -> Resolution:
        return Resolution(
            kind_,
            clv_percent=clv,
            price_move_percent=price_move,
            market_move_percent=market_move,
            gap_closed_percent=closed,
            note=note,
        )

    if closed < cfg.move_percent:
        return verdict_for(Verdict.HELD, "Abstand zum Markt besteht weiter")

    # Die Lücke ist zu - entscheidend ist, *wer* sie geschlossen hat. Dafür
    # zählt die Richtung, nicht der Betrag: nur ein **fallender** Buchmacher
    # hat sich korrigiert, nur ein **steigender** Markt ist nachgezogen.
    book_fell = (price_move or 0.0) <= -cfg.move_percent
    market_rose = (market_move or 0.0) >= cfg.move_percent
    # Hat der gemeldete Preis den späteren Markt überhaupt geschlagen? Ohne
    # das ist "korrigiert" eine Behauptung, die die eigenen Zahlen widerlegen.
    beat = (clv or 0.0) > 0.0

    if not book_fell and not market_rose:
        # Rechnerisch kleinerer Abstand, ohne dass eine Seite sich bewegt
        # hätte - das ist Rauschen, kein Ergebnis.
        return verdict_for(Verdict.HELD, "keine Seite hat sich nennenswert bewegt")
    if book_fell and beat:
        return verdict_for(
            Verdict.CORRECTED,
            "Buchmacher gefallen, Vorsprung zum Markt blieb"
            if market_rose
            else "der auffällige Buchmacher hat sich gesenkt",
        )
    if market_rose:
        return verdict_for(
            Verdict.MARKET_FOLLOWED,
            "der Markt ist über den gemeldeten Preis hinausgezogen"
            if book_fell
            else "der Markt ist zum gemeldeten Preis gestiegen",
        )
    # Der Buchmacher ist gefallen, aber der gemeldete Preis lag nie über dem
    # späteren Markt - dann gab es nichts zu gewinnen.
    return verdict_for(
        Verdict.MARKET_FOLLOWED, "der gemeldete Preis lag nicht über dem späteren Markt"
    )


def _resolve_move(
    alert_odds: float,
    final_price: float | None,
    previous_odds: float | None,
    suspended: bool,
    cfg: VerdictConfig,
) -> Resolution:
    """Bewegungsalarme kennen keinen Value - nur, ob die Bewegung hielt."""
    if final_price is None or suspended:
        return Resolution(Verdict.VANISHED, note="Quote nach der Bewegung nicht mehr verfügbar")

    price_move = _percent_change(alert_odds, final_price)
    span = (alert_odds - previous_odds) if previous_odds else None
    if span is None or abs(span) <= EPS:
        verdict = Verdict.HELD if abs(price_move or 0.0) < cfg.move_percent else Verdict.REVERTED
        return Resolution(
            verdict, price_move_percent=price_move, note="ohne Ausgangspreis geschätzt"
        )

    # Anteil des Sprungs, der wieder zurückgelaufen ist. 1.0 = ganz zurück,
    # negativ = der Preis ist in dieselbe Richtung weitergelaufen.
    retrace = (alert_odds - final_price) / span
    if retrace >= cfg.revert_fraction:
        # Über 100 % hinaus ist der Preis am Ausgangspunkt vorbeigeschossen -
        # für die Aussage "zurückgelaufen" bleibt die Anzeige bei 100 %.
        return Resolution(
            Verdict.REVERTED,
            price_move_percent=price_move,
            note=f"{min(retrace, 1.0) * 100:.0f} % der Bewegung zurückgelaufen",
        )
    if retrace <= 0.0:
        return Resolution(
            Verdict.HELD,
            price_move_percent=price_move,
            note="Bewegung hält und ist weitergelaufen",
        )
    return Resolution(
        Verdict.HELD,
        price_move_percent=price_move,
        note=f"Bewegung hält ({(1 - retrace) * 100:.0f} % geblieben)",
    )


__all__ = [
    "POSITIVE_VERDICTS",
    "VERDICT_LABELS",
    "Resolution",
    "Verdict",
    "VerdictConfig",
    "resolve",
]
