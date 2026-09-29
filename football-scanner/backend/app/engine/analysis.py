"""Match analysis: from a ``MatchContext`` to priced, scored selections.

Pipeline per statistic (goals, corners, cards):

1. estimate expected counts with each available model (season, form, xG);
2. blend them and apply documented squad/referee adjustments;
3. build the joint distribution of the two teams' counts;
4. price every selection off it, compare with the best available odds and
   score confidence, risk and rank.

When a statistic lacks the data its model needs, every selection on it is
returned as INSUFFICIENT_DATA instead of being priced from guesses.
"""

import statistics
from dataclasses import asdict, dataclass, field

from app.engine import rates
from app.engine.distributions import estimate_dispersion, negative_binomial_pmf
from app.engine.joint import JointDistribution, dixon_coles_matrix
from app.engine.markets import (
    CATEGORY_OF,
    MARKET_LABELS,
    STAT_OF,
    TAB_OF,
    Kind,
    Market,
    Selection,
    make_selection,
    price,
)
from app.engine.pricing import assess
from app.engine.scoring import (
    ConfidenceInputs,
    Rank,
    RankThresholds,
    RiskInputs,
    assess_risk,
    confidence,
    rank,
    squad_score,
)
from app.engine.types import MatchContext, MatchRecord, Quote, StatBaseline


@dataclass
class EngineSettings:
    min_matches: int = 5
    target_matches: int = 10
    min_league_matches: int = 20
    dixon_coles_rho: float = -0.05
    goals_weights: dict[str, float] = field(
        default_factory=lambda: {"season": 0.45, "form": 0.20, "xg": 0.35}
    )
    count_weights: dict[str, float] = field(default_factory=lambda: {"season": 0.7, "form": 0.3})
    referee_prior_matches: float = 8.0
    enabled_markets: set[Market] = field(default_factory=lambda: set(Market))
    thresholds: RankThresholds = field(default_factory=RankThresholds)


def _grid() -> list[Selection]:
    sels: list[Selection] = []
    add = sels.append
    for side in ("home", "draw", "away"):
        add(make_selection(Market.RESULT_1X2, side))
    for side in ("1X", "12", "X2"):
        add(make_selection(Market.DOUBLE_CHANCE, side))
    for side in ("home", "away"):
        add(make_selection(Market.DRAW_NO_BET, side))
    for line in (-1.25, -1.0, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, 1.0, 1.25):
        add(make_selection(Market.ASIAN_HANDICAP, "home", line))
        add(make_selection(Market.ASIAN_HANDICAP, "away", -line))
    for line in (0.5, 1.5, 2.5, 3.5, 4.5):
        for side in ("over", "under"):
            add(make_selection(Market.OVER_UNDER, side, line))
    for line in (1.0, 1.25, 1.75, 2.0, 2.25, 2.75, 3.0, 3.25):
        for side in ("over", "under"):
            add(make_selection(Market.ASIAN_TOTAL, side, line))
    for side in ("yes", "no"):
        add(make_selection(Market.BTTS, side))
    for team in ("home", "away"):
        for line in (0.5, 1.5, 2.5):
            for side in ("over", "under"):
                add(make_selection(Market.TEAM_GOALS, side, line, team))
    for line in (7.5, 8.5, 9.5, 10.5, 11.5):
        for side in ("over", "under"):
            add(make_selection(Market.CORNERS_OU, side, line))
    for line in (8.0, 9.0, 9.25, 9.75, 10.0, 11.0):
        for side in ("over", "under"):
            add(make_selection(Market.ASIAN_CORNERS, side, line))
    for line in (-2.5, -1.5, -0.5, 0.5, 1.5, 2.5):
        add(make_selection(Market.ASIAN_CORNERS, "home", line))
        add(make_selection(Market.ASIAN_CORNERS, "away", -line))
    for team in ("home", "away"):
        for line in (3.5, 4.5, 5.5, 6.5):
            for side in ("over", "under"):
                add(make_selection(Market.TEAM_CORNERS, side, line, team))
    for line in (2.5, 3.5, 4.5, 5.5):
        for side in ("over", "under"):
            add(make_selection(Market.CARDS_OU, side, line))
    for line in (3.0, 3.25, 3.75, 4.0, 4.25, 4.75, 5.0):
        for side in ("over", "under"):
            add(make_selection(Market.ASIAN_CARDS, side, line))
    for line in (-1.5, -0.5, 0.5, 1.5):
        add(make_selection(Market.ASIAN_CARDS, "home", line))
        add(make_selection(Market.ASIAN_CARDS, "away", -line))
    for team in ("home", "away"):
        for line in (0.5, 1.5, 2.5):
            for side in ("over", "under"):
                add(make_selection(Market.TEAM_CARDS, side, line, team))
    return sels


# Lines the match page always shows, priced even when no bookmaker quotes them.
STANDARD_SELECTIONS = _grid()


@dataclass
class ModelLambda:
    name: str
    lambda_home: float
    lambda_away: float
    matches_home: int
    matches_away: int


@dataclass
class StatModel:
    stat: str
    status: str  # OK / INSUFFICIENT_DATA
    reason: str | None = None
    lambda_home: float | None = None
    lambda_away: float | None = None
    models: list[ModelLambda] = field(default_factory=list)
    adjustments: list[str] = field(default_factory=list)
    data_quality: float = 0.0
    min_matches: int = 0
    relative_stderr: float = 1.0
    form_drift: float | None = None
    dispersion_home: float | None = None
    dispersion_away: float | None = None
    joint: JointDistribution | None = None
    model_joints: list[JointDistribution] = field(default_factory=list)

    def public(self) -> dict:
        d = asdict(self)
        d.pop("joint")
        d.pop("model_joints")
        return d


@dataclass
class Evaluation:
    key: str
    market: str
    market_label: str
    category: str
    tab: str
    stat: str
    label: str
    side: str
    team: str | None
    line: float | None
    status: str
    probability: float | None = None
    push_probability: float | None = None
    fair_odds: float | None = None
    odds: float | None = None
    bookmaker: str | None = None
    bookmakers: int = 0
    implied_probability: float | None = None
    no_vig_probability: float | None = None
    edge_pp: float | None = None
    value_pct: float | None = None
    confidence: int | None = None
    confidence_components: dict[str, float] = field(default_factory=dict)
    risk: str | None = None
    risk_factors: list[str] = field(default_factory=list)
    rank: str = Rank.INSUFFICIENT_DATA.value
    rank_note: str | None = None
    opening_odds: float | None = None
    movement_pct: float | None = None
    model_spread: float | None = None


@dataclass
class MatchAnalysis:
    fixture_id: int
    stats: dict[str, StatModel]
    evaluations: list[Evaluation]
    top_scores: list[dict]

    def public(self) -> dict:
        return {
            "fixture_id": self.fixture_id,
            "stats": {k: v.public() for k, v in self.stats.items()},
            "evaluations": [asdict(e) for e in self.evaluations],
            "top_scores": self.top_scores,
        }


# ---------------------------------------------------------------- models


def _share_with(records: list[MatchRecord], getter) -> float:
    if not records:
        return 0.0
    return sum(1 for r in records if getter(r) is not None) / len(records)


def _recent(records: list[MatchRecord], ctx: MatchContext, n: int = 20) -> list[MatchRecord]:
    return sorted((r for r in records if r.date < ctx.kickoff), key=lambda r: r.date, reverse=True)[
        :n
    ]


def _estimate_all(
    ctx: MatchContext,
    baseline: StatBaseline | None,
    get_for,
    get_against,
    settings: EngineSettings,
    specs: list[rates.ModelSpec],
) -> list[rates.RateEstimate]:
    out = []
    for spec in specs:
        est = rates.estimate(
            ctx.home_history,
            ctx.away_history,
            baseline,
            get_for,
            get_against,
            ctx.kickoff,
            spec,
            settings.min_matches,
        )
        if est is not None:
            out.append(est)
    return out


def _insufficient(stat: str, reason: str) -> StatModel:
    return StatModel(stat=stat, status=Rank.INSUFFICIENT_DATA.value, reason=reason)


def _form_drift(estimates: list[rates.RateEstimate]) -> float | None:
    by = {e.model: e for e in estimates}
    if "season" not in by or "form" not in by:
        return None
    s = by["season"].lambda_home + by["season"].lambda_away
    f = by["form"].lambda_home + by["form"].lambda_away
    return abs(f - s) / s if s > 0 else None


def goals_model(ctx: MatchContext, settings: EngineSettings) -> StatModel:
    base = ctx.league.goals
    if base is None or base.matches < settings.min_league_matches:
        return _insufficient("goals", "Not enough league matches for a baseline")
    estimates = _estimate_all(
        ctx, base, rates.goals_for, rates.goals_against, settings, [rates.SEASON, rates.FORM]
    )
    if not any(e.model == "season" for e in estimates):
        return _insufficient(
            "goals", f"Fewer than {settings.min_matches} matches of history for a team"
        )
    xg_base = ctx.league.xg
    if xg_base is not None and xg_base.matches >= settings.min_league_matches:
        xg_spec = rates.ModelSpec("xg", 120, 20, 1.5, 3)
        xg = rates.estimate(
            ctx.home_history,
            ctx.away_history,
            xg_base,
            rates.xg_for,
            rates.xg_against,
            ctx.kickoff,
            xg_spec,
            settings.min_matches,
        )
        if xg is not None:
            # xG indices are relative to league xG; scale to league goals.
            estimates.append(
                rates.RateEstimate(
                    model="xg",
                    lambda_home=base.home_mean * xg.home.attack * xg.away.defence,
                    lambda_away=base.away_mean * xg.away.attack * xg.home.defence,
                    home=xg.home,
                    away=xg.away,
                )
            )

    weighted = [(e, settings.goals_weights.get(e.model, 0.0)) for e in estimates]
    lh, la = rates.blend([(e, w) for e, w in weighted if w > 0])

    adjustments: list[str] = []
    lh, la = _squad_adjust(ctx, lh, la, adjustments)

    season = next(e for e in estimates if e.model == "season")
    recent = _recent(ctx.home_history, ctx) + _recent(ctx.away_history, ctx)
    has_xg = any(e.model == "xg" for e in estimates)
    quality = 0.7 + 0.3 * (1.0 if has_xg else _share_with(recent, rates.xg_for) * 0.5)

    model = StatModel(
        stat="goals",
        status="OK",
        lambda_home=lh,
        lambda_away=la,
        models=[
            ModelLambda(e.model, e.lambda_home, e.lambda_away, e.home.matches, e.away.matches)
            for e in estimates
        ],
        adjustments=adjustments,
        data_quality=min(1.0, quality),
        min_matches=season.min_matches,
        relative_stderr=season.relative_stderr(),
        form_drift=_form_drift(estimates),
    )
    rho = settings.dixon_coles_rho
    model.joint = dixon_coles_matrix(lh, la, rho)
    model.model_joints = [dixon_coles_matrix(e.lambda_home, e.lambda_away, rho) for e in estimates]
    return model


def _squad_adjust(ctx: MatchContext, lh: float, la: float, notes: list[str]) -> tuple[float, float]:
    for side, squad in (("home", ctx.home_squad), ("away", ctx.away_squad)):
        if squad.missing_goal_share:
            cut = min(0.20, 0.5 * squad.missing_goal_share)
            if side == "home":
                lh *= 1 - cut
            else:
                la *= 1 - cut
            notes.append(
                f"{side.title()} attack -{cut:.0%}: missing players account for "
                f"{squad.missing_goal_share:.0%} of goal contributions"
            )
        if squad.missing_key_defenders:
            bump = min(0.10, 0.03 * squad.missing_key_defenders)
            if side == "home":
                la *= 1 + bump
            else:
                lh *= 1 + bump
            notes.append(
                f"{side.title()} defence weakened +{bump:.0%}: "
                f"{squad.missing_key_defenders} regular defender(s)/goalkeeper missing"
            )
    return lh, la


def count_model(stat: str, ctx: MatchContext, settings: EngineSettings) -> StatModel:
    base = getattr(ctx.league, stat)
    getters = {
        "corners": (rates.corners_for, rates.corners_against),
        "cards": (rates.cards_for, rates.cards_against),
    }[stat]
    if base is None or base.matches < settings.min_league_matches:
        return _insufficient(stat, f"Not enough league {stat} data for a baseline")
    estimates = _estimate_all(ctx, base, *getters, settings, [rates.SEASON, rates.FORM])
    if not any(e.model == "season" for e in estimates):
        return _insufficient(
            stat, f"Fewer than {settings.min_matches} matches with {stat} data for a team"
        )
    lh, la = rates.blend([(e, settings.count_weights.get(e.model, 0.0)) for e in estimates])

    adjustments: list[str] = []
    recent = _recent(ctx.home_history, ctx) + _recent(ctx.away_history, ctx)
    quality = _share_with(recent, getters[0])
    if stat == "cards":
        ref = ctx.referee
        league_total = base.home_mean + base.away_mean
        if ref is not None and ref.matches > 0 and league_total > 0:
            k = settings.referee_prior_matches
            ratio = ref.avg_cards / league_total
            factor = (ref.matches * ratio + k) / (ref.matches + k)
            lh *= factor
            la *= factor
            adjustments.append(
                f"Referee {ref.name}: {ref.avg_cards:.2f} cards/match over {ref.matches} "
                f"(factor {factor:.2f})"
            )
        else:
            quality *= 0.85
            adjustments.append("Referee card history not available")

    season = next(e for e in estimates if e.model == "season")
    disp_h = estimate_dispersion(base.home_mean, base.home_var)
    disp_a = estimate_dispersion(base.away_mean, base.away_var)
    max_count = 25 if stat == "corners" else 12
    joint = JointDistribution.independent(
        negative_binomial_pmf(lh, disp_h, max_count), negative_binomial_pmf(la, disp_a, max_count)
    )
    model_joints = [
        JointDistribution.independent(
            negative_binomial_pmf(e.lambda_home, disp_h, max_count),
            negative_binomial_pmf(e.lambda_away, disp_a, max_count),
        )
        for e in estimates
    ]
    return StatModel(
        stat=stat,
        status="OK",
        lambda_home=lh,
        lambda_away=la,
        models=[
            ModelLambda(e.model, e.lambda_home, e.lambda_away, e.home.matches, e.away.matches)
            for e in estimates
        ],
        adjustments=adjustments,
        data_quality=quality,
        min_matches=season.min_matches,
        relative_stderr=season.relative_stderr(),
        form_drift=_form_drift(estimates),
        dispersion_home=disp_h,
        dispersion_away=disp_a,
        joint=joint,
        model_joints=model_joints,
    )


# ---------------------------------------------------------------- selections


def _price_dispersion(prices: tuple[float, ...]) -> float | None:
    if len(prices) < 2:
        return None
    mean = statistics.fmean(prices)
    return statistics.pstdev(prices) / mean if mean else None


def evaluate(
    selection: Selection,
    model: StatModel,
    quote: Quote | None,
    ctx: MatchContext,
    settings: EngineSettings,
) -> Evaluation:
    ev = Evaluation(
        key=selection.key,
        market=selection.market.value,
        market_label=MARKET_LABELS[selection.market],
        category=CATEGORY_OF[selection.market],
        tab=TAB_OF[selection.market],
        stat=STAT_OF[selection.market],
        label=selection.label(),
        side=selection.side,
        team=selection.team,
        line=selection.line,
        status=model.status,
    )
    if quote is not None:
        ev.odds = quote.odds
        ev.bookmaker = quote.bookmaker
        ev.bookmakers = quote.bookmakers
        ev.opening_odds = quote.opening_odds
        if quote.opening_odds:
            ev.movement_pct = (quote.odds - quote.opening_odds) / quote.opening_odds * 100
    if model.status != "OK" or model.joint is None:
        ev.rank_note = model.reason
        return ev

    outcome = price(selection, model.joint)
    value = assess(
        outcome, quote.odds if quote else None, quote.no_vig_probability if quote else None
    )
    ev.probability = value.probability
    ev.push_probability = value.push_probability
    ev.fair_odds = value.fair_odds
    ev.implied_probability = value.implied_probability
    ev.no_vig_probability = value.no_vig_probability
    ev.edge_pp = value.edge_pp
    ev.value_pct = value.value_pct

    probs = [price(selection, j).effective_probability for j in model.model_joints]
    spread = (max(probs) - min(probs)) if len(probs) > 1 else None
    ev.model_spread = spread

    squads = (ctx.home_squad, ctx.away_squad)
    key_missing = sum(s.missing_key_defenders for s in squads) + sum(
        1 for s in squads if s.missing_goal_share and s.missing_goal_share >= 0.2
    )
    sq = (
        min(squad_score(s.lineup_confirmed, s.injuries_known, 0) for s in squads)
        - 0.1 * key_missing
    )
    conf = confidence(
        ConfidenceInputs(
            data_quality=model.data_quality,
            min_matches=model.min_matches,
            target_matches=settings.target_matches,
            model_spread=spread,
            form_drift=model.form_drift,
            squad_score=max(0.2, sq),
            bookmakers=quote.bookmakers if quote else 0,
            price_dispersion=_price_dispersion(quote.prices) if quote else None,
            edge_pp=value.edge_pp,
            relative_stderr=model.relative_stderr,
        )
    )
    ev.confidence = conf.score
    ev.confidence_components = conf.components

    squad_known = all(bool(s.lineup_confirmed) or s.injuries_known for s in squads)
    risk = assess_risk(
        RiskInputs(
            probability=value.probability,
            stat=model.stat,
            data_quality=model.data_quality,
            squad_known=squad_known,
            key_missing=key_missing,
            bookmakers=quote.bookmakers if quote else 99,
            relative_stderr=model.relative_stderr,
            movement_pct=ev.movement_pct,
        )
    )
    ev.risk = risk.level.label
    ev.risk_factors = risk.factors
    r, note = rank(value.value_pct, conf.score, risk.level, settings.thresholds)
    ev.rank = r.value
    ev.rank_note = note
    return ev


def analyze(ctx: MatchContext, settings: EngineSettings | None = None) -> MatchAnalysis:
    settings = settings or EngineSettings()
    stats = {
        "goals": goals_model(ctx, settings),
        "corners": count_model("corners", ctx, settings),
        "cards": count_model("cards", ctx, settings),
    }
    quotes = {q.selection.key: q for q in ctx.quotes}
    selections = {s.key: s for s in STANDARD_SELECTIONS}
    for q in ctx.quotes:
        selections.setdefault(q.selection.key, q.selection)

    evaluations = [
        evaluate(sel, stats[sel.stat], quotes.get(key), ctx, settings)
        for key, sel in selections.items()
        if sel.market in settings.enabled_markets
    ]

    top_scores: list[dict] = []
    goals = stats["goals"]
    if goals.joint is not None:
        top_scores = [
            {"home": h, "away": a, "probability": p} for h, a, p in goals.joint.top_scores(15)
        ]
    return MatchAnalysis(
        fixture_id=ctx.fixture_id, stats=stats, evaluations=evaluations, top_scores=top_scores
    )


__all__ = ["EngineSettings", "Evaluation", "MatchAnalysis", "analyze", "Kind"]
