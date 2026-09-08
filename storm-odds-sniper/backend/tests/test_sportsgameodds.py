"""SportsGameOdds-Adapter.

Die Testdaten bilden das Schema der offiziellen, aus der OpenAPI-Spezifikation
generierten SDK nach (``SportsGameOdds/sports-odds-api-python``): Feldnamen,
Verschachtelung und die Zusammensetzung von ``oddID`` aus
``{statID}-{statEntityID}-{periodID}-{betTypeID}-{sideID}``.
"""

from __future__ import annotations

import httpx
import pytest

from backend.models.enums import EventStatus, MarketType, Period, SelectionCode, Sport
from backend.providers.base import ProviderAuthError, ProviderError, ProviderRateLimited
from backend.providers.sportsgameodds import SportsGameOddsProvider, american_to_decimal


def market(**overrides) -> dict:
    base = {
        "oddID": "points-home-game-ml-home",
        "statID": "points",
        "statEntityID": "home",
        "periodID": "game",
        "betTypeID": "ml",
        "sideID": "home",
        "marketName": "Moneyline",
        "byBookmaker": {
            "bet365": {"odds": "+150", "available": True},
            "pinnacle": {"odds": "+145", "available": True},
        },
    }
    base.update(overrides)
    return base


def event(**overrides) -> dict:
    base = {
        "eventID": "sgo-1",
        "leagueID": "EPL",
        "sportID": "SOCCER",
        "teams": {
            "home": {"names": {"long": "Arsenal", "short": "ARS"}, "score": 1},
            "away": {"names": {"long": "Chelsea", "short": "CHE"}, "score": 0},
        },
        "status": {
            "live": True,
            "started": True,
            "ended": False,
            "startsAt": "2026-09-08T18:30:00Z",
            "currentPeriodID": "2h",
        },
        "odds": {"points-home-game-ml-home": market()},
    }
    base.update(overrides)
    return base


def provider(**kwargs) -> SportsGameOddsProvider:
    return SportsGameOddsProvider(api_key="k" * 20, **kwargs)


def with_transport(prov: SportsGameOddsProvider, handler) -> SportsGameOddsProvider:
    prov._client = httpx.AsyncClient(base_url=prov.base_url, transport=httpx.MockTransport(handler))
    return prov


def page(rows: list[dict], cursor: str | None = None) -> dict:
    return {"data": rows, "nextCursor": cursor}


class TestQuotenumrechnung:
    """Die API liefert amerikanische Quoten als String ("-110")."""

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("+150", 2.50),
            ("-110", 1.9091),
            ("+100", 2.00),
            ("-200", 1.50),
            ("2.35", 2.35),  # bereits dezimal
            ("150", 2.50),  # amerikanisch ohne Vorzeichen
        ],
    )
    def test_known_formats(self, raw, expected):
        assert american_to_decimal(raw) == pytest.approx(expected, abs=0.001)

    @pytest.mark.parametrize("raw", [None, "", "abc", "0", "-", "1.00"])
    def test_unusable_values_are_rejected(self, raw):
        """Lieber keine Quote als eine falsch umgerechnete."""
        assert american_to_decimal(raw) is None

    def test_implausible_results_are_rejected(self):
        """Ein Missverständnis beim Format darf keinen Fantasiepreis erzeugen."""
        assert american_to_decimal("+999999") is None
        assert american_to_decimal("0.5") is None


class TestEventparsing:
    async def test_live_event_with_score(self):
        prov = with_transport(provider(), lambda r: httpx.Response(200, json=page([event()])))
        events = await prov.get_events()
        assert len(events) == 1
        snap = events[0]
        assert snap.sport is Sport.FOOTBALL
        assert snap.home == "Arsenal" and snap.away == "Chelsea"
        assert snap.status is EventStatus.LIVE
        assert snap.score.home == 1 and snap.score.away == 0
        assert snap.provider_event_id == "sgo-1"
        assert snap.league == "EPL"

    async def test_the_minute_is_not_invented(self):
        """Diese Quelle liefert keine Spielminute - sie bleibt leer."""
        prov = with_transport(provider(), lambda r: httpx.Response(200, json=page([event()])))
        snap = (await prov.get_events())[0]
        assert snap.football is not None
        assert snap.football.minute is None
        assert snap.football.period == "2h"

    @pytest.mark.parametrize(
        ("status", "expected"),
        [
            ({"live": True}, EventStatus.LIVE),
            ({"started": True, "live": False}, EventStatus.LIVE),
            ({"started": False, "live": False}, EventStatus.PRE_MATCH),
            ({"ended": True}, EventStatus.FINISHED),
            ({"completed": True}, EventStatus.FINISHED),
            ({"cancelled": True}, EventStatus.SUSPENDED),
        ],
    )
    async def test_status_mapping(self, status, expected):
        prov = with_transport(
            provider(), lambda r: httpx.Response(200, json=page([event(status=status)]))
        )
        assert (await prov.get_events())[0].status is expected

    async def test_other_sports_are_dropped(self):
        prov = with_transport(
            provider(), lambda r: httpx.Response(200, json=page([event(sportID="BASKETBALL")]))
        )
        assert await prov.get_events() == []
        assert prov.skipped["sportart"] == 1

    async def test_tennis_is_recognised(self):
        raw = event(
            sportID="TENNIS",
            teams={
                "home": {"names": {"long": "Sinner"}},
                "away": {"names": {"long": "Alcaraz"}},
            },
            status={"live": True, "currentPeriodID": "set2"},
        )
        prov = with_transport(provider(), lambda r: httpx.Response(200, json=page([raw])))
        snap = (await prov.get_events())[0]
        assert snap.sport is Sport.TENNIS
        assert snap.tennis is not None and snap.tennis.set_number == 2


class TestQuotenparsing:
    async def test_every_bookmaker_becomes_its_own_quote(self):
        prov = with_transport(provider(), lambda r: httpx.Response(200, json=page([event()])))
        quotes = await prov.get_odds()
        assert {q.bookmaker for q in quotes} == {"bet365", "pinnacle"}
        assert quotes[0].market.type is MarketType.MATCH_ODDS
        assert quotes[0].selection.code is SelectionCode.HOME
        assert quotes[0].price == pytest.approx(2.50)

    async def test_totals_carry_their_line(self):
        raw = event(
            odds={
                "points-all-game-ou-over": market(
                    betTypeID="ou",
                    sideID="over",
                    fairOverUnder="2.5",
                    byBookmaker={"bet365": {"odds": "-110", "overUnder": "2.5"}},
                )
            }
        )
        prov = with_transport(provider(), lambda r: httpx.Response(200, json=page([raw])))
        quote = (await prov.get_odds())[0]
        assert quote.market.type is MarketType.OVER_UNDER
        assert quote.market.line == pytest.approx(2.5)
        assert quote.selection.code is SelectionCode.OVER

    async def test_a_bookmakers_own_line_wins(self):
        """Alternative Lines: der Buchmacherwert schlägt den Marktwert."""
        raw = event(
            odds={
                "x": market(
                    betTypeID="ou",
                    sideID="under",
                    fairOverUnder="2.5",
                    byBookmaker={"bet365": {"odds": "-105", "overUnder": "3.5"}},
                )
            }
        )
        prov = with_transport(provider(), lambda r: httpx.Response(200, json=page([raw])))
        assert (await prov.get_odds())[0].market.line == pytest.approx(3.5)

    async def test_spread_maps_to_handicap(self):
        raw = event(
            odds={
                "x": market(
                    betTypeID="sp",
                    sideID="home",
                    fairSpread="-0.5",
                    byBookmaker={"bet365": {"odds": "-115", "spread": "-0.5"}},
                )
            }
        )
        prov = with_transport(provider(), lambda r: httpx.Response(200, json=page([raw])))
        quote = (await prov.get_odds())[0]
        assert quote.market.type is MarketType.HANDICAP
        assert quote.market.line == pytest.approx(-0.5)

    async def test_unavailable_lines_are_marked_suspended(self):
        raw = event(
            odds={"x": market(byBookmaker={"bet365": {"odds": "+150", "available": False}})}
        )
        prov = with_transport(provider(), lambda r: httpx.Response(200, json=page([raw])))
        assert (await prov.get_odds())[0].suspended is True

    async def test_period_is_carried_over(self):
        raw = event(odds={"x": market(periodID="h1")})
        prov = with_transport(provider(), lambda r: httpx.Response(200, json=page([raw])))
        assert (await prov.get_odds())[0].market.period is Period.FIRST_HALF


class TestNichtsWirdGeraten:
    """Unbekannte Kennungen werden übersprungen und gezählt, nicht zugeordnet."""

    async def test_player_props_are_skipped(self):
        raw = event(odds={"x": market(sideID="PLAYER_123", statID="goals")})
        prov = with_transport(provider(), lambda r: httpx.Response(200, json=page([raw])))
        assert await prov.get_odds() == []
        assert prov.skipped["seite:PLAYER_123"] == 1

    async def test_unknown_bet_type_is_skipped(self):
        raw = event(odds={"x": market(betTypeID="prop3way")})
        prov = with_transport(provider(), lambda r: httpx.Response(200, json=page([raw])))
        assert await prov.get_odds() == []
        assert prov.skipped["bet_type:prop3way"] == 1

    async def test_unknown_period_is_not_treated_as_full_time(self):
        """Ein Viertel darf nicht versehentlich als Vollzeit gelten."""
        raw = event(odds={"x": market(periodID="q3")})
        prov = with_transport(provider(), lambda r: httpx.Response(200, json=page([raw])))
        assert await prov.get_odds() == []
        assert prov.skipped["periode:q3"] == 1

    async def test_cancelled_markets_are_skipped(self):
        raw = event(odds={"x": market(cancelled=True)})
        prov = with_transport(provider(), lambda r: httpx.Response(200, json=page([raw])))
        assert await prov.get_odds() == []

    async def test_events_without_usable_odds_are_reported(self):
        """Sonst sähe ein Formatmissverständnis aus wie ein ruhiger Markt."""
        raw = event(odds={"x": market(betTypeID="unbekannt")})
        prov = with_transport(provider(), lambda r: httpx.Response(200, json=page([raw])))
        await prov.get_odds()
        assert "keine verwertbare Quote" in prov.health.detail


class TestAbrufUndFehler:
    async def test_live_only_sets_the_filter(self):
        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen.update(dict(request.url.params))
            return httpx.Response(200, json=page([]))

        prov = with_transport(provider(live_only=True), handler)
        await prov.get_events()
        assert seen["live"] == "true"
        assert "finalized" not in seen

    async def test_the_api_key_travels_in_the_header(self):
        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["key"] = request.headers.get("x-api-key")
            return httpx.Response(200, json=page([]))

        prov = provider()
        prov._client = httpx.AsyncClient(
            base_url=prov.base_url,
            transport=httpx.MockTransport(handler),
            headers={"x-api-key": prov._api_key},
        )
        await prov.get_events()
        assert seen["key"] == "k" * 20

    async def test_pagination_follows_the_cursor(self):
        calls: list[str | None] = []

        def handler(request: httpx.Request) -> httpx.Response:
            cursor = request.url.params.get("cursor")
            calls.append(cursor)
            if cursor is None:
                return httpx.Response(200, json=page([event()], cursor="c2"))
            return httpx.Response(200, json=page([event(eventID="sgo-2")]))

        prov = with_transport(provider(), handler)
        events = await prov.get_events()
        assert calls == [None, "c2"]
        assert {e.provider_event_id for e in events} == {"sgo-1", "sgo-2"}

    async def test_pagination_is_bounded(self):
        """Ein endloser Cursor darf das Kontingent nicht leerlaufen lassen."""
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(200, json=page([event()], cursor="weiter"))

        prov = with_transport(provider(max_pages=2), handler)
        await prov.get_events()
        assert calls["n"] == 2

    async def test_one_fetch_serves_events_and_odds(self):
        """Sonst kostet ein Poll-Takt doppeltes Kontingent."""
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(200, json=page([event()]))

        prov = with_transport(provider(), handler)
        await prov.get_events()
        await prov.get_odds()
        assert calls["n"] == 1

    @pytest.mark.parametrize("status", [401, 403])
    async def test_a_bad_key_is_not_retried(self, status):
        prov = with_transport(provider(), lambda r: httpx.Response(status, json={}))
        with pytest.raises(ProviderAuthError):
            await prov.get_events()

    async def test_rate_limit_carries_retry_after(self):
        prov = with_transport(
            provider(),
            lambda r: httpx.Response(429, json={}, headers={"retry-after": "30"}),
        )
        with pytest.raises(ProviderRateLimited) as exc:
            await prov.get_events()
        assert exc.value.retry_after == 30.0

    async def test_network_failure_becomes_a_provider_error(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("dns")

        prov = with_transport(provider(), handler)
        with pytest.raises(ProviderError, match="nicht erreichbar"):
            await prov.get_events()

    async def test_a_missing_data_key_is_an_error_not_silence(self):
        prov = with_transport(provider(), lambda r: httpx.Response(200, json={"foo": 1}))
        with pytest.raises(ProviderError, match="'data' fehlt"):
            await prov.get_events()

    async def test_remaining_quota_is_tracked(self):
        prov = with_transport(
            provider(),
            lambda r: httpx.Response(
                200, json=page([]), headers={"x-ratelimit-remaining-month": "2400"}
            ),
        )
        await prov.get_events()
        assert prov.health.rate_limit_remaining == 2400

    async def test_missing_key_is_refused_at_construction(self):
        with pytest.raises(ProviderAuthError, match="SGO_API_KEY"):
            SportsGameOddsProvider(api_key="")
