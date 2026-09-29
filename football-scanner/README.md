# Football Value Scanner

A web dashboard that scans football matches, estimates probabilities with its
own statistical model and compares them with bookmaker prices to find
**value**: selections where the model's probability is higher than the price
implies.

It is an analysis tool. It never claims a match is fixed, never promises
profit and never invents data: a statistic the providers do not supply is
shown as **N/A**, and a market without enough history is marked
**INSUFFICIENT DATA** instead of being priced from guesses. There is no
Telegram integration. Everything is in the web dashboard.

---

## Architecture

```
 browser ──▶ web (Next.js 15, TypeScript, Tailwind, shadcn/ui)
               │  /api/* is proxied, so the session cookie stays first-party
               ▼
             backend (FastAPI) ─────────┐
               │                        │
               ▼                        ▼
          PostgreSQL                  Redis (cache, locks, rate limits)
               ▲
               │
             worker (python -m app.worker)
               │  fixtures · statistics · line-ups · injuries · odds
               ▼
       provider adapters (API-Football, The Odds API)
```

| Path                      | What lives there                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `backend/app/engine/`     | The model. Pure Python, no I/O: distributions, ratings, markets, pricing, confidence, risk, ranking, bankroll. |
| `backend/app/providers/`  | Provider interfaces and adapters. A new vendor is one new adapter.                                             |
| `backend/app/services/`   | Sync, analysis, settlement and background jobs.                                                                |
| `backend/app/api/routes/` | REST API: auth, dashboard, matches, scanner, history, bankroll, admin.                                         |
| `backend/alembic/`        | Database migrations.                                                                                           |
| `web/app/`                | Pages: dashboard, scanner, matches, match detail, history, bankroll, admin, login.                             |
| `web/components/`         | UI components (shadcn/ui style) and the match/admin panels.                                                    |

This folder is self-contained: it shares nothing with the rest of the
repository and can be moved to its own repository as is.

## Quick start (Docker)

```bash
cd football-scanner
cp .env.example .env        # set POSTGRES_PASSWORD and FVS_SECRET_KEY
docker compose up -d --build
```

Open http://localhost:3000 and register. **The first account becomes the
administrator.** Then, in **Admin**:

1. **API keys** — enter the API-Football key (and The Odds API key if odds
   should come from there). Keys are encrypted at rest.
2. **Leagues** — press _Load league catalogue_, enable the leagues to scan and,
   when using The Odds API, map each league to its competition key.
3. **System** — the worker starts syncing on its own; _Run now_ queues a job
   immediately.

After the first history sync the dashboard fills with analysed matches.

## Local development

Requirements: Python 3.11+, Node 22, PostgreSQL 16, Redis 7.

```bash
# backend
cd football-scanner/backend
python -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
export FVS_SECRET_KEY=$(python -c "import secrets; print(secrets.token_urlsafe(48))")
export FVS_DATABASE_URL=postgresql+psycopg://scanner:scanner@127.0.0.1:5432/scanner
export FVS_COOKIE_SECURE=false
alembic upgrade head
uvicorn app.main:app --reload --port 8000     # API, docs at /api/docs
python -m app.worker                          # background jobs (second terminal)

# web
cd football-scanner/web
npm ci
BACKEND_URL=http://127.0.0.1:8000 npm run dev  # http://localhost:3000
```

Checks (the same ones CI runs):

```bash
cd backend && ruff check . && ruff format --check . && alembic check && python -m pytest
cd web && npm run lint && npm run typecheck && npm run build
```

The backend tests run against a real PostgreSQL database
(`FVS_TEST_DATABASE_URL`, default `scanner_test` on localhost).

## Data sources

| Provider                                        | Used for                                                                                                                                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [API-Football v3](https://www.api-football.com) | Leagues, fixtures, results, statistics (shots, possession, corners, cards, xG where available), events, line-ups, injuries/suspensions, head-to-head, live scores, and optionally odds |
| [The Odds API v4](https://the-odds-api.com)     | Bookmaker odds: 1X2, spreads, totals, BTTS, DNB, double chance, team totals, alternate lines, corners and cards where offered                                                          |

Both sit behind `FootballDataProvider` / `OddsProvider` in
`app/providers/base.py`; services never call a vendor directly. Every request
is counted per provider, endpoint and day (Admin → API usage), cached in Redis
where safe, and retried with back-off on 429/5xx.

Not supplied by these sources and therefore always N/A: big chances,
defensive errors, pressing, defensive line, counter-attacks and travel.

## The model

For each fixture and each statistic (goals, corners, cards):

1. **Expected counts.** Every team gets attack and defence indices relative to
   the league average at the relevant venue. Matches are time-decayed, the
   venue being played (home form for the home side, away form for the away
   side) is weighted 1.5×, and indices are shrunk toward the league average so
   a small sample cannot produce extreme numbers.
2. **Several models.** Goals use a season model, a recent-form model (last 6)
   and an xG model when xG exists; corners and cards use season and form.
   They are blended; their disagreement feeds confidence.
3. **Documented adjustments.** Missing players reduce attack by their share of
   goal contributions (capped); missing regular defenders raise the opponent's
   expectation; the referee's card history scales the card model. Each
   adjustment is listed on the match page.
4. **Joint distribution.** Goals use Poisson with the Dixon-Coles low-score
   correction; corners and cards use a negative binomial with dispersion
   estimated from the league.
5. **Every market from one table.** 1X2, double chance, DNB, Asian handicap,
   Asian and classic totals, BTTS, team totals, corners, Asian corners, team
   corners, cards, Asian cards and team cards are all priced from the same
   distribution, so they are consistent with one another. Quarter lines split
   the stake over the neighbouring lines; integer lines refund. Pricing and
   settlement use the same grading function.

### Value

```
Fair odds   = 1 / model probability
Implied     = 1 / bookmaker odds
Edge (pp)   = model probability − implied probability
EV / Value  = probability × odds − 1
```

The model probability is computed first and never taken from the bookmaker.
For lines that can refund, the probability shown excludes the refunded stake,
so fair odds remain exactly `1 / probability` and the EV shown is the exact
expected return per unit staked. Example: 67% at 1.85 → fair 1.49, implied
54.05%, edge +12.95 pp, value +23.95%.

### Confidence (0–100)

A separate score for how much the inputs can be trusted — **not** a
probability. Components: data quality, sample size, agreement between models,
form stability, squad availability, market consistency (bookmaker agreement,
and a penalty when the model disagrees with the whole market by more than
15 points) and statistical stability.

### Risk

LOW / MEDIUM / HIGH / VERY HIGH from volatility (low-probability outcomes,
cards and corners), data quality, line-up uncertainty, market liquidity,
statistical variance and unusual odds movement.

### Ranking

🔥 Best value · 🟢 Strong value · 🟡 Moderate value · ⚪ No value · 🔴 Avoid.
The labels grade the statistical signal, not the outcome. Thresholds are
editable in Admin → Thresholds. A value above 50% is labelled _Avoid — verify
data_ because it far more often means bad input than a real edge.

### Odds movement

Every price change is stored. The match page shows opening, current, lowest
and highest odds with a chart. A large move is reported as _Strong market
movement detected_ — never as evidence that a match is arranged.

## Signals and history

Evaluations that pass the signal policy (Admin → Thresholds) are stored as
signals. They follow the market until kick-off and are frozen at kick-off, so
the track record only uses prices that were actually available. A signal whose
value disappears before kick-off is marked _withdrawn_ and does not count.
After the match, signals are graded from the final data (90-minute result;
corner and card markets are voided when only extra-time totals exist).

History shows ROI, win rate, average odds, total bets, profit and maximum
drawdown at a flat one-unit stake, split by 1X2, Goals, Corners, Cards, Asian
and BTTS. Admin → Model performance adds calibration, Brier score and log loss.

## Bankroll

Fixed stake, percentage stake, Kelly and half Kelly (default) with a maximum
stake cap (default 2% of bankroll). Stakes are never increased after a loss.

## Security

- Passwords hashed with Argon2; sessions are random tokens stored only as
  SHA-256 digests; the cookie is httpOnly, SameSite=Lax and Secure by default.
- State-changing requests from foreign origins are rejected.
- Login and registration are rate-limited.
- Admin/User roles; the last active admin cannot be demoted.
- Provider keys entered in the admin panel are encrypted with a key derived
  from `FVS_SECRET_KEY`, and only ever shown masked.

## Background jobs

| Job              | Default interval | Does                                                             |
| ---------------- | ---------------- | ---------------------------------------------------------------- |
| `fixtures`       | 3 h              | Upcoming fixtures for enabled leagues                            |
| `league_history` | 24 h             | Season results and a daily batch of league statistics            |
| `team_history`   | 6 h              | Last matches, statistics and head-to-head for teams playing soon |
| `injuries`       | 2 h              | Injuries and suspensions for the next 48 hours                   |
| `lineups`        | 10 min           | Line-ups near kick-off, live and final statistics                |
| `live`           | 2 min            | Live scores and status                                           |
| `odds`           | 20 min           | Bookmaker prices                                                 |
| `analysis`       | 20 min           | Probabilities, value, confidence, risk and signals               |
| `settlement`     | 30 min           | Grades finished signals                                          |

Intervals, look-ahead days and history depth are editable in Admin →
Thresholds → Data refresh.

## Responsible use

The model can be wrong, markets are efficient more often than not, and a
positive expected value says nothing about any single bet. Bet only what you
can afford to lose.
