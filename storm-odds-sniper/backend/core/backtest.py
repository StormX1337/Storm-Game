"""Stimmt das Empfehlungsmodell? Gegen die eigenen Alarme gehalten.

Das Empfehlungsmodul (``recommendation.py``) trifft eine starke Behauptung:
eine sehr große gemeldete Abweichung sei *kein* Vorteil, sondern ein
Datenfehler - und ein Alarm mit +11 % darum die bessere Wette als einer mit
+45 %. Das ist begründet, aber es ist eine Behauptung. Geprüft war sie nie.

Prüfbar ist sie mit Daten, die längst da sind: jeder Alarm wird nach einer
Wartezeit gegen den Markt gehalten (``verdict.py``) und bekommt einen
Closing Line Value sowie ein Urteil. Damit lässt sich fragen:

1. **Trennt der Grad?** Haben Alarme mit „spielen" im Mittel besseren CLV
   als die mit „nicht spielen"? Wenn nicht, sortiert der Grad nichts und
   die ganze Stufung ist Zierde.
2. **Hilft die Schrumpfung?** Die besten Alarme nach *glaubwürdigem*
   Vorteil gegen die besten nach *gemeldetem* Value - welche Auswahl hatte
   hinterher die besseren Nachkontrollen?

**Warum hier der Median steht und nicht der Mittelwert.** Der erste Lauf
gegen echte Daten lieferte für die verworfenen Alarme einen mittleren CLV
von +92 % und für die nach Value sortierte Auswahl +768 %. Solche Zahlen
sind keine Vorteile, sie sind zusammengebrochene Referenzen: CLV ist
``alarmquote / spätere_faire_quote - 1``, und wenn der Nenner kaputt ist,
explodiert der Bruch. Ein Mittelwert über 300 Zeilen kippt von einer
Handvoll solcher Ausreißer. Der Median tut das nicht - dieselbe Überlegung,
aus der schon die faire Quote als Median gebildet wird.

**Und warum der CLV allein die Streitfrage nicht entscheiden kann.**

    gemeldeter Value = alarmquote / faire_quote        - 1
    CLV              = alarmquote / spätere_faire_quote - 1

Das ist zweimal dieselbe Formel mit einer anderen Referenz. Wer nach dem
gemeldeten Value sortiert und mit dem CLV benotet, lässt eine Größe über
sich selbst urteilen - ein bisschen später gemessen. Diese Auswahl gewinnt
den Vergleich fast zwangsläufig, und zwar besonders dann, wenn die faire
Quote kaputt war: derselbe Fehler steht in beiden Zahlen.

Deshalb kommt als zweiter Schiedsrichter das **Urteil** dazu: hat der
Buchmacher seinen Preis am Ende selbst nach unten gezogen? Das ist keine
Umskalierung derselben Größe, sondern eine unabhängige Beobachtung - und
damit die belastbarere Antwort auf „war der Fehlpreis echt?".

Ehrlichkeitshinweise, die auch in der README stehen:

* CLV ist **kein Gewinn**. Er misst nur, dass ein Preis besser war als der
  spätere Marktkonsens. Ein Modell kann jeden Vergleich hier gewinnen und
  trotzdem kein Geld verdienen.
* Die Alarme sind **keine Zufallsstichprobe**: gemeldet wurde nur, was die
  Filter durchgelassen haben. Über Preise, die nie einen Alarm auslösten,
  sagt das hier nichts.
* Unterhalb weniger Dutzend ausgewerteter Alarme je Gruppe ist jeder
  Unterschied Rauschen. Die Auswertung sagt das dann auch, statt eine Zahl
  hinzustellen, die nach Erkenntnis aussieht.
"""

from __future__ import annotations

import statistics
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from backend.core.recommendation import Grade, Recommendation

#: Unterhalb so vieler ausgewerteter Alarme je Gruppe wird kein Mittelwert
#: als Aussage geführt. Dieselbe Haltung wie bei Trefferbilanz und Kasse.
MIN_PER_GROUP = 20

#: So viele Alarme umfasst der Kopf-an-Kopf-Vergleich je Seite.
HEAD_TO_HEAD = 25

#: Ab hier misst der CLV keinen besseren Preis mehr, sondern eine kaputte
#: Referenz. Ein faire Quote, die sich ohne Spielstandsänderung verdoppelt,
#: gibt es nicht - der Fall "Tor gefallen" ist in ``verdict.py`` bereits als
#: SUPERSEDED aussortiert. Solche Zeilen werden NICHT weggeworfen (der
#: Median verträgt sie), sie werden gezählt und ausgewiesen: eine hohe Zahl
#: ist ein Datenbefund, kein Vorteil.
MAX_PLAUSIBLE_CLV = 100.0

#: Urteil, das einen Fehlpreis unabhängig vom CLV bestätigt: der Buchmacher
#: hat seinen eigenen Preis nach unten gezogen.
CONFIRMING_VERDICT = "corrected"


@dataclass(slots=True)
class GroupResult:
    """Was aus einer Gruppe von Alarmen geworden ist."""

    grade: str
    count: int = 0
    #: Nur die mit Nachkontrolle - der Rest kann nichts belegen.
    scored: int = 0
    #: Der belastbare Wert. Siehe Modulkopf.
    median_clv_percent: float | None = None
    #: Nur zum Vergleich daneben: klafft er weit auf, steckt eine Handvoll
    #: kaputter Referenzen in der Gruppe.
    avg_clv_percent: float | None = None
    beat_close: int = 0
    #: Buchmacher hat selbst korrigiert - der unabhängige Beleg.
    corrected: int = 0
    #: CLV jenseits jeder Plausibilität, siehe MAX_PLAUSIBLE_CLV.
    extreme: int = 0
    avg_credible_edge: float | None = None
    avg_raw_edge: float | None = None

    @property
    def beat_close_share(self) -> float | None:
        if self.scored <= 0:
            return None
        return self.beat_close / self.scored * 100.0

    @property
    def corrected_share(self) -> float | None:
        if self.scored <= 0:
            return None
        return self.corrected / self.scored * 100.0

    @property
    def reliable(self) -> bool:
        return self.scored >= MIN_PER_GROUP

    def to_json(self) -> dict[str, Any]:
        return {
            "grade": self.grade,
            "count": self.count,
            "scored": self.scored,
            "median_clv_percent": _round(self.median_clv_percent),
            "avg_clv_percent": _round(self.avg_clv_percent),
            "beat_close": self.beat_close,
            "beat_close_share": _round(self.beat_close_share),
            "corrected": self.corrected,
            "corrected_share": _round(self.corrected_share),
            "extreme": self.extreme,
            "avg_credible_edge": _round(self.avg_credible_edge),
            "avg_raw_edge": _round(self.avg_raw_edge),
            "reliable": self.reliable,
        }


@dataclass(slots=True)
class HeadToHead:
    """Die Streitfrage: schrumpfen oder nach Value sortieren?"""

    n: int = 0
    credible_median_clv: float | None = None
    raw_median_clv: float | None = None
    #: Anteil „Buchmacher korrigierte selbst" je Auswahl - der Schiedsrichter,
    #: der nicht aus derselben Formel stammt wie der gemeldete Value.
    credible_corrected_share: float | None = None
    raw_corrected_share: float | None = None
    #: Zeilen mit unplausiblem CLV je Auswahl.
    credible_extreme: int = 0
    raw_extreme: int = 0
    #: Wie viele Alarme in beiden Auswahlen stehen - viel Überschneidung
    #: heißt, dass der Vergleich wenig aussagt.
    overlap: int = 0

    @property
    def difference(self) -> float | None:
        if self.credible_median_clv is None or self.raw_median_clv is None:
            return None
        return self.credible_median_clv - self.raw_median_clv

    @property
    def corrected_difference(self) -> float | None:
        if self.credible_corrected_share is None or self.raw_corrected_share is None:
            return None
        return self.credible_corrected_share - self.raw_corrected_share

    @property
    def reliable(self) -> bool:
        return self.n >= MIN_PER_GROUP

    @property
    def verdict(self) -> str:
        """Ein Satz - und ausdrücklich keiner, wenn die Datenlage fehlt."""
        if not self.reliable:
            return (
                f"Zu wenig ausgewertet ({self.n} je Seite, nötig {MIN_PER_GROUP}). "
                "Noch keine Aussage."
            )
        unterschied = self.difference
        if unterschied is None:
            return "Kein CLV vorhanden - noch keine Aussage."

        # Steckt die Value-Auswahl voller unplausibler CLV-Werte, misst der
        # Vergleich kaputte Referenzen und nicht das Modell.
        if self.raw_extreme > self.n / 2:
            return (
                f"Nicht auswertbar: {self.raw_extreme} der {self.n} nach Value "
                "sortierten Alarme haben einen CLV jenseits jeder "
                f"Plausibilität (über {MAX_PLAUSIBLE_CLV:.0f} %). Dort ist die "
                "spätere faire Quote zusammengebrochen - verglichen würden "
                "kaputte Referenzen, nicht Vorteile."
            )

        if abs(unterschied) < 1.0:
            kern = f"Kein nennenswerter Unterschied ({unterschied:+.1f} Prozentpunkte Median-CLV)."
        elif unterschied > 0:
            kern = f"Die Schrumpfung liegt vorn ({unterschied:+.1f} Prozentpunkte Median-CLV)."
        else:
            kern = (
                f"Die Schrumpfung liegt beim CLV zurück ({unterschied:+.1f} "
                "Prozentpunkte Median). Das ist aber ein befangener Vergleich: "
                "CLV und gemeldeter Value sind dieselbe Formel mit anderer "
                "Referenz."
            )

        korrektur = self.corrected_difference
        if korrektur is None:
            return kern + " Urteile fehlen - der unabhängige Vergleich entfällt."
        if abs(korrektur) < 5.0:
            return (
                f"{kern} Beim unabhängigen Maß (Buchmacher korrigierte selbst) "
                f"nehmen sich beide nichts ({korrektur:+.0f} Prozentpunkte)."
            )
        if korrektur > 0:
            return (
                f"{kern} Beim unabhängigen Maß liegt die Schrumpfung vorn: "
                f"{korrektur:+.0f} Prozentpunkte mehr selbst korrigierte Preise."
            )
        return (
            f"{kern} Auch beim unabhängigen Maß liegt sie zurück "
            f"({korrektur:+.0f} Prozentpunkte selbst korrigierte Preise) - "
            "das spricht wirklich gegen die Einstellung, PLAUSIBLE_EDGE_PERCENT "
            "prüfen."
        )

    def to_json(self) -> dict[str, Any]:
        return {
            "n": self.n,
            "credible_median_clv": _round(self.credible_median_clv),
            "raw_median_clv": _round(self.raw_median_clv),
            "difference": _round(self.difference),
            "credible_corrected_share": _round(self.credible_corrected_share),
            "raw_corrected_share": _round(self.raw_corrected_share),
            "corrected_difference": _round(self.corrected_difference),
            "credible_extreme": self.credible_extreme,
            "raw_extreme": self.raw_extreme,
            "overlap": self.overlap,
            "reliable": self.reliable,
            "verdict": self.verdict,
        }


@dataclass(slots=True)
class Backtest:
    """Das Gesamtergebnis."""

    total: int = 0
    #: Alarme mit Nachkontrolle - nur die können etwas belegen.
    scored: int = 0
    #: Zeilen mit unplausiblem CLV über alle Gruppen.
    extreme: int = 0
    groups: list[GroupResult] = field(default_factory=list)
    head_to_head: HeadToHead = field(default_factory=HeadToHead)
    separates: bool | None = None
    notes: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "total": self.total,
            "scored": self.scored,
            "extreme": self.extreme,
            "groups": [g.to_json() for g in self.groups],
            "head_to_head": self.head_to_head.to_json(),
            "separates": self.separates,
            "notes": list(self.notes),
        }


def _round(value: float | None) -> float | None:
    return round(value, 2) if value is not None else None


def _mean(values: list[float]) -> float | None:
    return statistics.fmean(values) if values else None


def _median(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


def is_extreme(clv_percent: float | None) -> bool:
    """Misst dieser CLV noch einen Preis - oder schon eine kaputte Referenz?"""
    return clv_percent is not None and abs(clv_percent) > MAX_PLAUSIBLE_CLV


@dataclass(slots=True)
class Sample:
    """Ein Alarm, so weit er für die Auswertung zählt."""

    grade: str
    credible_edge: float
    raw_edge: float
    #: ``None`` = nie nachkontrolliert; zählt in keinen Mittelwert.
    clv_percent: float | None
    #: Urteil aus ``verdict.py`` - der vom CLV unabhängige Beleg.
    verdict: str | None = None
    #: "live" oder "prematch". Zwei verschiedene Märkte mit verschiedenen
    #: Schwellen - sie in einen Mittelwert zu werfen, mittelt zwei Welten zu
    #: einer Zahl, die für keine von beiden gilt.
    phase: str = "unknown"

    @property
    def confirmed(self) -> bool:
        return self.verdict == CONFIRMING_VERDICT


def sample_from(
    recommendation: Recommendation,
    clv_percent: float | None,
    verdict: str | None = None,
    phase: str = "unknown",
) -> Sample:
    return Sample(
        grade=recommendation.grade.value,
        credible_edge=recommendation.credible_edge_percent,
        raw_edge=recommendation.raw_edge_percent,
        clv_percent=clv_percent,
        verdict=verdict,
        phase=phase,
    )


def _seite(rows: list[Sample]) -> tuple[float | None, float | None, int]:
    """Median-CLV, Anteil selbst korrigierter Preise, Zahl der Ausreißer."""
    if not rows:
        return None, None, 0
    median = _median([r.clv_percent for r in rows if r.clv_percent is not None])
    anteil = sum(1 for r in rows if r.confirmed) / len(rows) * 100.0
    return median, anteil, sum(1 for r in rows if is_extreme(r.clv_percent))


def analyse(samples: Iterable[Sample]) -> Backtest:
    """Die beiden Fragen beantworten - oder sagen, dass es nicht reicht."""
    rows = list(samples)
    ergebnis = Backtest(total=len(rows))
    bewertet = [row for row in rows if row.clv_percent is not None]
    ergebnis.scored = len(bewertet)
    ergebnis.extreme = sum(1 for row in bewertet if is_extreme(row.clv_percent))

    # ---------------------------------------------------------- 1) Grade
    for grade in (Grade.STRONG, Grade.MODERATE, Grade.WEAK, Grade.SKIP):
        gruppe = [row for row in rows if row.grade == grade.value]
        if not gruppe:
            continue
        mit_clv = [row for row in gruppe if row.clv_percent is not None]
        ergebnis.groups.append(
            GroupResult(
                grade=grade.value,
                count=len(gruppe),
                scored=len(mit_clv),
                median_clv_percent=_median([row.clv_percent for row in mit_clv]),
                avg_clv_percent=_mean([row.clv_percent for row in mit_clv]),
                beat_close=sum(1 for row in mit_clv if row.clv_percent > 0),
                corrected=sum(1 for row in mit_clv if row.confirmed),
                extreme=sum(1 for row in mit_clv if is_extreme(row.clv_percent)),
                avg_credible_edge=_mean([row.credible_edge for row in gruppe]),
                avg_raw_edge=_mean([row.raw_edge for row in gruppe]),
            )
        )

    spielbar = [row for row in bewertet if row.grade in (Grade.STRONG.value, Grade.MODERATE.value)]
    verworfen = [row for row in bewertet if row.grade == Grade.SKIP.value]
    if len(spielbar) >= MIN_PER_GROUP and len(verworfen) >= MIN_PER_GROUP:
        # Über den Median, nicht den Mittelwert: siehe Modulkopf.
        ergebnis.separates = _median([r.clv_percent for r in spielbar]) > _median(
            [r.clv_percent for r in verworfen]
        )
    else:
        ergebnis.notes.append(
            f"Für den Vergleich spielbar/verworfen fehlen Daten "
            f"({len(spielbar)} bzw. {len(verworfen)}, nötig je {MIN_PER_GROUP})."
        )

    # ------------------------------------------------- 2) Kopf an Kopf
    if bewertet:
        n = min(HEAD_TO_HEAD, len(bewertet))
        nach_credible = sorted(bewertet, key=lambda r: r.credible_edge, reverse=True)[:n]
        nach_roh = sorted(bewertet, key=lambda r: r.raw_edge, reverse=True)[:n]
        # Überschneidung über die Identität der Objekte: zwei Alarme mit
        # denselben Zahlen sind für diesen Zweck derselbe Fall.
        gemeinsam = sum(1 for row in nach_credible if any(row is other for other in nach_roh))
        c_median, c_anteil, c_extrem = _seite(nach_credible)
        r_median, r_anteil, r_extrem = _seite(nach_roh)
        ergebnis.head_to_head = HeadToHead(
            n=n,
            credible_median_clv=c_median,
            raw_median_clv=r_median,
            credible_corrected_share=c_anteil,
            raw_corrected_share=r_anteil,
            credible_extreme=c_extrem,
            raw_extreme=r_extrem,
            overlap=gemeinsam,
        )

    if ergebnis.extreme:
        anteil = ergebnis.extreme / max(ergebnis.scored, 1) * 100.0
        ergebnis.notes.append(
            f"{ergebnis.extreme} von {ergebnis.scored} nachkontrollierten Alarmen "
            f"({anteil:.0f} %) haben einen CLV über {MAX_PLAUSIBLE_CLV:.0f} %. Solche "
            "Werte messen keinen besseren Preis, sondern eine zusammengebrochene "
            "faire Quote. Sie sind hier nicht weggeworfen - der Median verträgt "
            "sie -, aber der Mittelwert daneben ist von ihnen verdorben."
        )

    if not bewertet:
        ergebnis.notes.append(
            "Kein einziger Alarm ist nachkontrolliert. Ohne Closing Line Value "
            "lässt sich nichts belegen - FOLLOWUP_ENABLED prüfen und später "
            "erneut laufen lassen."
        )
    return ergebnis
