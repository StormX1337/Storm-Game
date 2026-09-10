"""Stimmt das Empfehlungsmodell? Gegen die eigenen Alarme gehalten.

Das Empfehlungsmodul (``recommendation.py``) trifft eine starke Behauptung:
eine sehr große gemeldete Abweichung sei *kein* Vorteil, sondern ein
Datenfehler - und ein Alarm mit +11 % darum die bessere Wette als einer mit
+45 %. Das ist begründet, aber es ist eine Behauptung. Geprüft war sie nie.

Prüfbar ist sie mit Daten, die längst da sind: jeder Alarm wird nach einer
Wartezeit gegen den Markt gehalten (``verdict.py``) und bekommt einen
Closing Line Value. Damit lässt sich fragen:

1. **Trennt der Grad?** Haben Alarme mit „spielen" im Mittel besseren CLV
   als die mit „nicht spielen"? Wenn nicht, sortiert der Grad nichts und
   die ganze Stufung ist Zierde.
2. **Hilft die Schrumpfung?** Die zehn nach *glaubwürdigem* Vorteil besten
   Alarme gegen die zehn nach *gemeldetem* Value besten - welche Auswahl
   hatte hinterher den besseren CLV? Das ist die eigentliche Streitfrage,
   und sie hat genau zwei mögliche Antworten.

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


@dataclass(slots=True)
class GroupResult:
    """Was aus einer Gruppe von Alarmen geworden ist."""

    grade: str
    count: int = 0
    #: Nur die mit Nachkontrolle - der Rest kann nichts belegen.
    scored: int = 0
    avg_clv_percent: float | None = None
    beat_close: int = 0
    avg_credible_edge: float | None = None
    avg_raw_edge: float | None = None

    @property
    def beat_close_share(self) -> float | None:
        if self.scored <= 0:
            return None
        return self.beat_close / self.scored * 100.0

    @property
    def reliable(self) -> bool:
        return self.scored >= MIN_PER_GROUP

    def to_json(self) -> dict[str, Any]:
        return {
            "grade": self.grade,
            "count": self.count,
            "scored": self.scored,
            "avg_clv_percent": _round(self.avg_clv_percent),
            "beat_close": self.beat_close,
            "beat_close_share": _round(self.beat_close_share),
            "avg_credible_edge": _round(self.avg_credible_edge),
            "avg_raw_edge": _round(self.avg_raw_edge),
            "reliable": self.reliable,
        }


@dataclass(slots=True)
class HeadToHead:
    """Die Streitfrage: schrumpfen oder nach Value sortieren?"""

    n: int = 0
    credible_avg_clv: float | None = None
    raw_avg_clv: float | None = None
    #: Wie viele Alarme in beiden Auswahlen stehen - viel Überschneidung
    #: heißt, dass der Vergleich wenig aussagt.
    overlap: int = 0

    @property
    def difference(self) -> float | None:
        if self.credible_avg_clv is None or self.raw_avg_clv is None:
            return None
        return self.credible_avg_clv - self.raw_avg_clv

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
        if abs(unterschied) < 1.0:
            return (
                f"Kein nennenswerter Unterschied ({unterschied:+.1f} Prozentpunkte). "
                "Die Schrumpfung schadet nicht, nützt hier aber auch nicht messbar."
            )
        if unterschied > 0:
            return (
                f"Die Schrumpfung liegt vorn ({unterschied:+.1f} Prozentpunkte CLV). "
                "Nach gemeldetem Value zu sortieren wäre schlechter gewesen."
            )
        return (
            f"Die Schrumpfung liegt zurück ({unterschied:+.1f} Prozentpunkte CLV). "
            "Das spricht gegen die aktuelle Einstellung - PLAUSIBLE_EDGE_PERCENT "
            "prüfen."
        )

    def to_json(self) -> dict[str, Any]:
        return {
            "n": self.n,
            "credible_avg_clv": _round(self.credible_avg_clv),
            "raw_avg_clv": _round(self.raw_avg_clv),
            "difference": _round(self.difference),
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
    groups: list[GroupResult] = field(default_factory=list)
    head_to_head: HeadToHead = field(default_factory=HeadToHead)
    separates: bool | None = None
    notes: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "total": self.total,
            "scored": self.scored,
            "groups": [g.to_json() for g in self.groups],
            "head_to_head": self.head_to_head.to_json(),
            "separates": self.separates,
            "notes": list(self.notes),
        }


def _round(value: float | None) -> float | None:
    return round(value, 2) if value is not None else None


def _mean(values: list[float]) -> float | None:
    return statistics.fmean(values) if values else None


@dataclass(slots=True)
class Sample:
    """Ein Alarm, so weit er für die Auswertung zählt."""

    grade: str
    credible_edge: float
    raw_edge: float
    #: ``None`` = nie nachkontrolliert; zählt in keinen Mittelwert.
    clv_percent: float | None


def sample_from(recommendation: Recommendation, clv_percent: float | None) -> Sample:
    return Sample(
        grade=recommendation.grade.value,
        credible_edge=recommendation.credible_edge_percent,
        raw_edge=recommendation.raw_edge_percent,
        clv_percent=clv_percent,
    )


def analyse(samples: Iterable[Sample]) -> Backtest:
    """Die beiden Fragen beantworten - oder sagen, dass es nicht reicht."""
    rows = list(samples)
    ergebnis = Backtest(total=len(rows))
    bewertet = [row for row in rows if row.clv_percent is not None]
    ergebnis.scored = len(bewertet)

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
                avg_clv_percent=_mean([row.clv_percent for row in mit_clv]),
                beat_close=sum(1 for row in mit_clv if row.clv_percent > 0),
                avg_credible_edge=_mean([row.credible_edge for row in gruppe]),
                avg_raw_edge=_mean([row.raw_edge for row in gruppe]),
            )
        )

    spielbar = [row for row in bewertet if row.grade in (Grade.STRONG.value, Grade.MODERATE.value)]
    verworfen = [row for row in bewertet if row.grade == Grade.SKIP.value]
    if len(spielbar) >= MIN_PER_GROUP and len(verworfen) >= MIN_PER_GROUP:
        ergebnis.separates = _mean([r.clv_percent for r in spielbar]) > _mean(
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
        ergebnis.head_to_head = HeadToHead(
            n=n,
            credible_avg_clv=_mean([row.clv_percent for row in nach_credible]),
            raw_avg_clv=_mean([row.clv_percent for row in nach_roh]),
            overlap=gemeinsam,
        )

    if not bewertet:
        ergebnis.notes.append(
            "Kein einziger Alarm ist nachkontrolliert. Ohne Closing Line Value "
            "lässt sich nichts belegen - FOLLOWUP_ENABLED prüfen und später "
            "erneut laufen lassen."
        )
    return ergebnis
