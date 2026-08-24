# LeagueOps

A fantasy football operations platform built on Sleeper league data: draft
preparation, live matchup odds, post-game forensics, and an automated weekly
league recap.

Not a data viewer. It computes **one canonical stat packet per league per week**,
then renders that packet as a dashboard, a set of odds, an after-action report,
and a recap that gets forwarded to eleven other people.

---

## The three principles

**Compute once, render many.** The odds engine, the AAR, the power rankings and
the Commissioner's Report all read the same weekly stat packet. No module
recomputes anything. When four surfaces disagree about what happened in a week,
users stop trusting all four.

**Grounded output only.** The recap is funny because it cites real, verifiable
facts about real managers. Every number in a generated report traces back to a
field in the stat packet, and anything that cannot be traced is cut before
delivery — see [the fact-check pass](#the-fact-check-pass).

**Retroactive first.** Everything backward-looking works on Sleeper data alone.
Everything forward-looking needs a projection source. The backward half has no
external dependency and it is the half people share, so it ships first.

---

## Architecture

```
INGESTION   Sleeper API (scheduled jobs) ──> normalized Postgres tables
                              │
COMPUTE     optimal lineup solver · odds engine · all-play · luck index
            power rankings · award resolution
                              │
                              ▼
                    STAT PACKET  (one JSON doc per league per week)
                              │
        ┌─────────────┬───────┴───────┬──────────────┐
     Dashboard     Odds board        AAR          Recap
      (live)         (live)      (post-game)      (LLM)
```

| Layer | Choice | Why |
|---|---|---|
| App | Next.js App Router | Server-side fetching solves the browser CORS/CSP problem entirely |
| DB | Postgres (Neon or Vercel Postgres) | The queries are all joins and aggregates |
| Cache | Upstash Redis | Player dictionary, live polling, odds snapshots |
| Jobs | Vercel Cron | Ingestion cadence differs wildly by data type |
| Generation | Anthropic API | Recap and AAR narrative |
| Auth | Clerk (optional) | Sleeper has no OAuth, so accounts are local |

### The player dictionary boundary

Sleeper's `/players/nfl` is roughly 10MB and their docs ask that it be called at
most once per day. It lives server-side only: a daily cron fetches it, reduces it
to `{id, name, position, team, injury_status}`, and writes the reduced map to
Redis. Nothing outside `lib/sleeper/players.ts` sees the raw shape and it never
reaches a browser.

**This is the single biggest reason this is a server app and not a client-side
tool.** If you are tempted to move a lookup to the client, look up players by id
through `resolvePlayers()` instead.

### Sleeper polling cadence

| Endpoint | Cadence | Notes |
|---|---|---|
| `/state/nfl` | 15 min | Source of truth for current week and phase |
| `/league/{id}` | daily | Scoring settings, roster positions |
| `/league/{id}/rosters` | hourly, 5 min on game days | |
| `/league/{id}/users` | daily | |
| `/league/{id}/matchups/{week}` | **60 s during game windows** | Drives live odds |
| `/league/{id}/transactions/{week}` | hourly | |
| `/draft/{id}/picks` | 5 s during an active draft | War room live sync |
| `/players/nfl` | daily, once | Server-side only |

Sleeper asks callers to stay under 1000 requests/minute globally. At a 60-second
tick one league costs one call per minute, so a few thousand leagues is
comfortable — **provided the poller stays shared and fans out from one cached
fetch per league, never one per user session.** `/api/cron/odds` is written that
way; keep it that way.

---

## Getting started

```bash
npm install
cp .env.example .env.local     # fill in DATABASE_URL at minimum
npm run db:migrate             # applies lib/db/schema.sql, idempotent
npm run dev
```

Then open http://localhost:3000 and paste a Sleeper league ID — the long number
in your league's Sleeper URL.

```bash
npm test          # 236 tests, no database or API key needed
npm run typecheck
npm run check     # both
```

### Environment

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres. Everything that persists needs it. |
| `ANTHROPIC_API_KEY` | for reports | The recap and AAR narrative |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | recommended | Falls back to an in-process map, which is wrong for serverless |
| `CRON_SECRET` | in production | `/api/cron/*` is open without it |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` | optional | Auth is bypassed entirely when unset |

### Deploying

**This ships configured for Vercel's Hobby plan**, which is more restrictive than
the spec's ingestion design assumes. Three limits shape the config, and all three
reject a deployment outright rather than degrading:

| Hobby limit | What it forces |
|---|---|
| 60s max function duration | Every `maxDuration` is 60. The spec's longer jobs are budgeted instead. |
| 2 cron jobs per project | `/api/cron/players` and `/api/cron/leagues` are merged into `/api/cron/daily`. |
| No cron more frequent than daily | The 60-second odds tick cannot be a Vercel cron here at all. |

So `vercel.json` carries exactly two crons: the daily refresh and the weekly
packet build.

**The odds tick runs from GitHub Actions instead**
(`.github/workflows/odds-tick.yml`). Set two repository secrets:

- `LEAGUEOPS_URL` — your deployment's base URL, no trailing slash
- `CRON_SECRET` — the same value as the Vercel environment variable

Be clear-eyed about what this costs: GitHub's scheduler has a five-minute floor
and runs late under load, so you get a ~5-minute tick rather than a 60-second
one. The swing chart still works — peak, comeback index, clinch and turning
point are all computed from whatever ticks exist — but the curve is coarser and a
turning point is attributed to a five-minute window rather than a one-minute one.
For a bragging-rights instrument that is a fair trade; it is not the spec's
design.

#### Working inside a 60-second function

Two jobs can genuinely exceed 60 seconds, and both handle it explicitly rather
than being killed:

- **Fan-out crons** (`/api/cron/odds`, `/api/cron/packet`, `/api/cron/daily`)
  carry a `TimeBudget` and stop one league short of the ceiling, returning
  `skipped` and `elapsedMs`. A killed invocation loses its work silently and
  reports nothing; stopping short keeps what it did and says where it stopped.
  Anything missed is rebuilt with `?leagueId=`.
- **Report generation** takes a deadline and drops the storyline-maintenance
  pass when it is close to it. That pass is the right thing to shed: the report
  is already written and verified by then, so a timeout would throw away both the
  output and the API spend that bought it, while skipping continuity costs one
  week of callbacks.

#### If you move to a plan with longer functions and minute-level crons

1. Raise `maxDuration` to 300 on the cron and report routes, and
   `FUNCTION_BUDGET_MS` in `lib/jobs/budget.ts` to match.
2. Raise the generation deadline in `app/api/leagues/[leagueId]/report/route.ts`.
3. Move the odds tick back into `vercel.json` at minute granularity and delete
   the GitHub Actions workflow:

   ```json
   { "path": "/api/cron/odds", "schedule": "* 17-23 * * 0" }
   ```

4. Optionally split `/api/cron/daily` back into the `players` and `leagues`
   routes, which still exist and are still individually callable.

Game-window schedules are in UTC and cover Sunday afternoon through Monday night
ET plus Thursday. Adjust for your league's actual habits.

**Set `CRON_SECRET` in production.** Without it the cron routes accept anyone,
including the GitHub Actions workflow's caller and everyone else.

---

## The odds engine

There is no sportsbook for a head-to-head fantasy matchup, so **we are the book**.
These are computed win probabilities rendered in a familiar format, and the UI
says so: "LeagueOps line", never "Vegas line". No money moves through the
platform, and it should stay that way — side-pot handling is a legal and payments
problem, and it is not what makes the feature fun.

### Distributions

Each starter's weekly points are modeled as a **gamma parameterised by mean and
coefficient of variation**. A normal underprices ceiling games and misprices
exactly the tails that decide close matchups.

| Position | CV | | Position | CV |
|---|---|---|---|---|
| QB | 0.35 | | TE | 0.70 |
| RB | 0.55 | | K | 0.60 |
| WR | 0.65 | | DEF | 0.75 |

Per-player CV is fitted where the sample supports it (≥8 games) and falls back to
the positional prior otherwise. Injury designations zero-inflate: a Questionable
tag becomes a mixture of `p(inactive) × 0` and `(1-p) × gamma`, which is a very
different shape from shading the mean down.

### Correlation

**Most tools ignore this and it changes upset probability materially.** If a
manager starts a QB and that QB's WR1, their scores move together, so the team's
outcome distribution is wider than independence implies.

| Relationship | ρ |
|---|---|
| Same team, QB ↔ pass catcher | 0.45 |
| Same team, QB ↔ RB | 0.10 |
| Same team, two pass catchers | −0.10 |
| Opposite sides of one NFL game | 0.15 |
| DEF vs the offense it faces | −0.20 |

Sampling is a Gaussian copula: correlated normals through a Cholesky factor, then
transformed to the marginal gammas. A matrix assembled from pairwise priors is
not guaranteed positive definite, so `cholesky()` repairs it with a ridge rather
than failing.

The tests pin both directions of the effect: correlation makes a stacked underdog
win more often than independence says (≈0.8pp at a 10-point deficit), and it does
*not* help a stacked lineup that is already even money.

### Live odds

A team's live score is banked points plus remaining expectation:

```
final:  contribution = actual,              variance = 0
pre:    contribution ~ full distribution
live:   remaining   = 1 - game_pct_elapsed
        mean_rem    = projection × remaining
        cv_rem      = position_cv × sqrt(remaining)
        contribution = actual_so_far + gamma(mean_rem, cv_rem)
```

Variance scales with `sqrt(remaining)` rather than linearly: a player with one
quarter left retains more than a quarter of their outcome uncertainty, because
garbage-time touchdowns are real. When every player is final, variance is zero
and win probability snaps to 0 or 1 — that moment is the clinch.

Lines are seeded per (league, week, matchup, minute) so two page loads inside the
same minute produce the same number. A line that jitters by half a point on
identical inputs reads as a broken product.

### The swing chart

Every tick is persisted, and the resulting curve is the richest source of
material in the product:

- **Peak win probability** — the *loser's* high-water mark. "Led 94% at 4:12 and lost."
- **Biggest swing** — largest single-tick delta, attributed to the player who caused it.
- **Comeback index** — the winner's minimum. Below 10% is a genuine heist.
- **Dead on arrival** — the loser never cleared 25%.
- **Clinch time** — when the outcome stopped being in doubt, scanning backwards so a late swing pushes it later.

Two of these read the loser rather than the winner, and that is deliberate: the
winner's peak is 1.0 and their DOA flag is false in every completed matchup, so
measured on the winner they carry no information at all. (Both were written the
wrong way round first; the tests caught it.)

---

## The optimal lineup solver

**Maximum-weight bipartite matching, not greedy sorting.** Greedy fails on flex
eligibility in a way that is easy to miss and always looks fine: it burns the
FLEX on the best remaining flex-eligible player and then finds a mandatory slot
empty. The problem is tiny (≤30 players × ≤11 slots) so it is solved exactly with
the Hungarian algorithm.

Two invocations, one implementation:

- **Prospective**, weights = projections → start/sit, with the delta expressed as
  *win probability added*. "Starting Kincaid is +6.2% to win" is far more
  actionable than "+2.1 projected points", because points only matter relative to
  the opponent's distribution.
- **Retroactive**, weights = actual points → optimal score, points left on the
  bench, coaching efficiency.

`benchPointsLeft` is optimal minus actual, not the sum of bench scores: a 30-point
bench WR is not 30 points left behind if there was nowhere legal to put them.

---

## The Commissioner's Report

R-rated weekly recap, generated from the stat packet, built to be pasted into a
league chat. **This is the growth loop**: one commissioner installs it and eleven
league members receive a report with their name in it. The footer is the
acquisition channel, and every delivery target carries it.

### Three passes

A single pass produces a listicle — asked to write a recap, a model dutifully
summarises all six matchups at equal length and finds nothing.

1. **Angle selection.** Stat packet in, the five most interesting angles out,
   ranked, with the numbers backing each. No prose. This pass is what forces a
   choice about what is actually notable.
2. **Writing.** Angles + voice + heat level + per-manager opt-downs → the report,
   in fixed sections, weighted by drama.
3. **Fact check.** Deterministic verification against the packet.

### The fact-check pass

**Pass 3 is not a model call.** A model that hallucinates cannot be the thing
that catches hallucinations, so verification is pure code (`lib/report/factcheck.ts`).

It indexes every number the stat packet supports — team scores, optimals, bench
regrets, margins, probabilities, award evidence, waiver ROI, running award counts
— then checks every numeric literal in the draft against that index. **Claims are
cut, not corrected.** A fabricated stat in a league recap is the fastest way to
lose a commissioner's trust because eleven people will check it, and a silently
corrected number is worse than a missing sentence: the reader never learns the
tool got it wrong.

The same pass enforces the content rule and the heat dial, rather than trusting
the prompt to have been obeyed.

The failure rate is logged with every report. **A rising rate means the packet
schema and the prompt have drifted apart** — that is the signal to look at, not
any individual cut.

Two things it deliberately does *not* do, both worth knowing before you rely on it:

- It verifies that a number **exists** in the packet, not that it is being used
  to mean what it meant there. A yardage total that coincides with someone's
  points-against will survive. Binding claims to fields is future work.
- Rounding is allowed only for claims carrying a decimal. Letting a bare integer
  stand as the rounding of a decimal opens a ±0.5 window around every packet
  number, which with a few hundred of them covers most integers a writer could
  invent. The prompt tells the writer to quote figures exactly, so the strictness
  costs nothing real.

### Heat dial

The commissioner sets a ceiling. Individual managers may opt themselves **down**,
never up past it — that asymmetry is the whole safety model and it is enforced in
code.

| Level | Register | Profanity |
|---|---|---|
| Locker Room | Sharp, dry | none |
| Group Chat | Profane, personal about football | unrestricted |
| Unhinged | Sustained abuse, elaborate metaphor | unrestricted |

### The one content rule

**Roasts target fantasy sins only** — bad picks, dead benches, cowardly trade
offers, unset lineups, the guy who drafted his own team's backup RB in the
fourth. Nothing about real-life appearance, family, work, finances, or health.

This is a product decision before it is a taste decision. Specific
football-grounded abuse is genuinely funnier than generic insult, and it is what
keeps the report shareable rather than the thing that gets the group chat locked.
It is a hard constraint in the system prompt *and* enforced in the fact-check
pass.

### Voice presets

Drunk ESPN anchor · hard-boiled noir detective · WWE promo · pit-lane reporter ·
British football commentator · true-crime docuseries narrator.

Voice affects diction and structure only. The facts and awards are identical
across presets, which is a useful correctness check: if two voices disagree about
a number, one is fabricating.

### Storyline memory

What makes the report feel written rather than generated. A per-season thread
table holds running narratives — a lopsided trade, a four-week slide, a rivalry,
a draft pick aging badly. Each week the generator receives live threads and
returns `advance`, `resolve` or `retire`.

A resolved thread gets exactly one callback and then goes quiet. A joke
referenced in six consecutive weeks is dead, and `applyStorylineUpdates` enforces
that lifecycle rather than leaving it to the model's judgement.

### Delivery

Formatted **for** the destination, not one blob reformatted four times: Sleeper
league chat (plain text, split to a character budget on sentence boundaries),
email (HTML), Discord (embeds, 25-field and 1024-character caps respected), Slack
(Block Kit mrkdwn).

---

## Repository layout

```
app/
  page.tsx                        connect a league
  leagues/[leagueId]/             dashboard, odds board, report, war room, AAR
  api/leagues/connect             league connect flow
  api/leagues/[id]/report         three-pass generation
  api/cron/{players,leagues,odds,packet}
lib/
  sleeper/     client, types, the player dictionary boundary
  compute/     lineup · gamma · correlation · odds · standings · swing
               awards · transactions · packet          (pure, no DB or network)
  report/      heat · voices · prompts · generate · factcheck · delivery
  aar/         after-action report builder
  warroom/     draft tendency mining, run detection
  jobs/        ingestion, packet build, odds tick
  db/          schema.sql, pool, repository
tests/         234 tests, fixtures under tests/fixtures
```

Everything in `lib/compute` is a pure function over plain data — no database, no
network, no `server-only` import. That is what makes the whole engine testable end
to end, and it is worth preserving.

---

## Build status against the spec

| Phase | Status |
|---|---|
| 1 — Foundation: ingestion, player dictionary, schema, connect flow, dashboard | done |
| 2 — Compute core: solver, all-play, luck, power rankings, stat packet | done |
| 3 — Commissioner's Report: three passes, heat, voices, storylines, delivery | done |
| 4 — Odds engine: Monte Carlo with correlation, live tick, swing chart | done except the projection source |
| 5 — AAR: per-matchup forensics over the odds snapshots | done |
| 6 — War room: tendency mining and run detection | engine done, live board pending |

### What is not wired up

**A projection source.** This is the open decision that blocks the forward-looking
half, and everything else is built around its absence:

- The odds board runs on positional replacement-level estimates and the UI says
  so. Real lines need real projections.
- Power score redistributes the roster-strength weight rather than feeding zeros
  through the composite and quietly compressing every score.
- Next week's opening lines come back null instead of invented, so the recap's
  "next week" section degrades to a fixture list.

`projections` has a `source` column, so blending consensus against
market-implied prop lines is a config change rather than a rewrite. Sportsbook
player props are the sharpest publicly available projection source — real money
moves them — but they cost money, add a vendor dependency, and cover only ~150
players a week. That is an upgrade path, not v1.

**NFL schedule data.** Sleeper exposes neither the fixture list nor a game clock,
and two things want them. Both are options on `tickOdds`, so wiring in any
schedule source turns them on without touching the engine:

- `gameProgress` (team → 0..1) drives the live banked-plus-remaining split.
  Without it `tickOdds` treats any player with points on the board as
  half-elapsed and everyone else as pre-game — deliberately conservative, since
  it never claims a game is further along than we know.
- `nflOpponents` (team → opponent) is what lets the two **cross-team correlation
  tiers** fire at all. The engine implements the shootout effect and the
  defense-versus-opposing-offense tier and the tests cover them, but with no
  fixture list every cross-team pair looks unrelated in production and those
  tiers silently contribute nothing.

Supplying these is the cheapest real accuracy win available to the live board.

**The war room's live half.** Tendency mining, run detection and survival odds are
implemented and tested; the live board, tier cliffs and 5-second draft sync are
the offseason build.

**Clerk.** `middleware.ts` is a pass-through. Swap it for `clerkMiddleware()` and
set the two keys to turn auth on.

### Open decisions from the spec

1. **Projection source** — free consensus scrape, paid vendor, market-implied
   props, or an internal model. Blocks phase 4 and nothing else.
2. **Multi-platform** — ESPN and Yahoo have no comparable public API.
   Sleeper-only is a real constraint and a real focus. Decide before the data
   model calcifies.
3. **Pricing** — recap generation free for the commissioner (it is the growth
   loop), personal AAR and war room paid, per-league rather than per-seat.
4. **Historical backfill** — two prior seasons makes tendency mining and rivalry
   storylines work immediately, which makes week one feel like week ten.

---

## A note on testing

The Sleeper API is unreachable from some CI and sandbox environments, so the
compute layer is tested against `tests/fixtures/league.ts` — a four-team league
with a full week designed so every metric has an unambiguous expected value: a
manager who loses to his own bench, a heist from a 6% low-water mark, a low score,
and a manager who started a player already ruled out.

Three bugs were found by writing those tests and fixed in the code rather than in
the assertions. They are called out at the relevant places above, because each one
was a case of a metric being measured against the side of the matchup where it is
constant by construction — a mistake worth recognising the shape of.
