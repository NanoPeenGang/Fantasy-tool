import { notFound } from 'next/navigation';
import { formatAmerican, formatSpread, simulateMatchup } from '@/lib/compute/odds';
import { hashSeed } from '@/lib/compute/random';
import { getLeague, weekProjections } from '@/lib/db/queries';
import { currentState, fetchWeek } from '@/lib/jobs/ingest';
import { toStarterStates } from '@/lib/jobs/odds';
import { LeagueNav } from '../nav';

export const dynamic = 'force-dynamic';

/**
 * The odds board. Lines are recomputed on request here rather than read from the
 * last persisted tick, so a page load during games shows the current number
 * without waiting for the poller.
 */
export default async function OddsPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  const { leagueId } = await params;
  const { week: weekParam } = await searchParams;

  const league = await getLeague(leagueId);
  if (!league) notFound();

  let week: number;
  let error: string | null = null;
  try {
    week = weekParam ? Number(weekParam) : (await currentState()).week;
  } catch {
    week = weekParam ? Number(weekParam) : 1;
    error = 'Could not reach Sleeper for the current week.';
  }

  let board: Awaited<ReturnType<typeof buildBoard>> = [];
  let hasProjections = false;

  if (!error) {
    try {
      const projections = await weekProjections(league.season, week);
      hasProjections = Object.keys(projections).length > 0;
      board = await buildBoard(league, week, projections);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Could not build the board.';
    }
  }

  return (
    <main>
      <h1>Odds board</h1>
      <p className="lede">
        {league.name} · week {week}
      </p>
      <LeagueNav leagueId={leagueId} />

      <div className="notice info">
        <strong>These are LeagueOps lines, not sportsbook lines.</strong> There is no book
        taking the other side, so they carry no vig. They are computed win probabilities
        rendered in a familiar format, for bragging rights only.
      </div>

      {!hasProjections && !error && (
        <div className="notice">
          <strong>No projection source configured.</strong> The board is running on
          positional replacement-level estimates, which treats every starter at a position as
          interchangeable. Load projections into the <code>projections</code> table to get
          real lines.
        </div>
      )}

      {error && (
        <div className="notice">
          <strong>Could not build the board.</strong> {error}
        </div>
      )}

      {board.length === 0 && !error ? (
        <div className="empty">No matchups for this week yet.</div>
      ) : (
        <div className="grid grid-2">
          {board.map((game) => (
            <div key={game.matchupId} className="card odds-card">
              <div>
                <div className="odds-side">
                  <span className="odds-name">{game.a}</span>
                  <span className="odds-line">{formatAmerican(game.moneylineA)}</span>
                </div>
                <div className="odds-side">
                  <span className="odds-name">{game.b}</span>
                  <span className="odds-line">{formatAmerican(game.moneylineB)}</span>
                </div>
              </div>

              <div>
                <div className="probbar">
                  <span style={{ width: `${Math.round(game.winProbA * 100)}%` }} />
                </div>
                <div className="odds-meta" style={{ marginTop: 6 }}>
                  <span>
                    {game.a} {Math.round(game.winProbA * 100)}%
                  </span>
                  <span>
                    {game.b} {Math.round((1 - game.winProbA) * 100)}%
                  </span>
                </div>
              </div>

              <div className="odds-meta">
                <span>Spread {formatSpread(game.spread, game.a, game.b)}</span>
                <span>Total {game.total}</span>
                <span>
                  Live {game.scoreA} — {game.scoreB}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

async function buildBoard(
  league: NonNullable<Awaited<ReturnType<typeof getLeague>>>,
  week: number,
  projections: Record<string, number>,
) {
  const snapshot = await fetchWeek(league, week);

  return snapshot.matchups
    .filter((matchup) => matchup.b !== null)
    .map((matchup) => {
      const b = matchup.b as NonNullable<typeof matchup.b>;
      const line = simulateMatchup(
        toStarterStates(matchup.a, snapshot.players, projections),
        toStarterStates(b, snapshot.players, projections),
        {
          iterations: 10_000,
          // Bucketed to the minute so two page loads inside the same minute
          // agree; without it the line jitters and reads as broken.
          seed: hashSeed(league.id, week, matchup.matchupId, Math.floor(Date.now() / 60_000)),
        },
      );

      return {
        matchupId: matchup.matchupId,
        a: matchup.a.manager,
        b: b.manager,
        scoreA: matchup.a.score,
        scoreB: b.score,
        winProbA: line.winProbA,
        spread: line.spread,
        total: line.total,
        moneylineA: line.moneylineA,
        moneylineB: line.moneylineB,
      };
    });
}
