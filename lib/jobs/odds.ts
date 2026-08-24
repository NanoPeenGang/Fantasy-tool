import 'server-only';

import { simulateMatchup } from '@/lib/compute/odds';
import { hashSeed } from '@/lib/compute/random';
import type { MatchupWeek, OddsSnapshot, PlayerRef, StarterState, TeamWeek } from '@/lib/compute/types';
import { insertOddsSnapshot, upsertMatchup, weekProjections, type LeagueRow } from '@/lib/db/queries';
import { fetchWeek } from './ingest';

/**
 * The live odds tick. Runs every 60 seconds during game windows.
 *
 * One fetch per league per tick fans out to every matchup in it. Persisting each
 * tick is not incidental — the stored curve is what produces the peak, the
 * biggest swing, the comeback index and the clinch, which is to say most of the
 * material the recap and the AAR are built from.
 */

export const EMPTY_STARTER = '0';

export type TickResult = {
  week: number;
  matchups: number;
  snapshots: OddsSnapshot[];
  /** True when every starter in the league has gone final. */
  weekComplete: boolean;
};

export type TickOptions = {
  iterations?: number;
  /**
   * Game progress per NFL team, 0 to 1, from whatever schedule source is
   * configured. Absent, every unfinished player is treated as pre-game, which
   * is the right conservative default: it never claims a game is further along
   * than we know it to be.
   */
  gameProgress?: Record<string, number>;
  /**
   * This week's NFL fixtures as team -> opponent. Sleeper does not expose the
   * schedule, and without it the two cross-team correlation tiers (the shootout
   * effect, and a defense against the offense it faces) cannot fire — the
   * engine supports them, but every pair looks unrelated. Supplying this is a
   * cheap, real accuracy win; see the README.
   */
  nflOpponents?: Record<string, string>;
  now?: Date;
};

export async function tickOdds(
  league: LeagueRow,
  week: number,
  options: TickOptions = {},
): Promise<TickResult> {
  const snapshot = await fetchWeek(league, week, { persist: false });
  const projections = await weekProjections(league.season, week);
  const now = options.now ?? new Date();
  const capturedAt = now.toISOString();

  const snapshots: OddsSnapshot[] = [];
  let allFinal = true;

  for (const matchup of snapshot.matchups) {
    if (!matchup.b) continue;

    const startersA = toStarterStates(matchup.a, snapshot.players, projections, options);
    const startersB = toStarterStates(matchup.b, snapshot.players, projections, options);

    const finished = [...startersA, ...startersB].every((s) => s.gameStatus === 'final');
    if (!finished) allFinal = false;

    // Seeding on the matchup and the minute keeps a line stable within a tick:
    // identical inputs must not produce a line that jitters by half a point,
    // because users read that as the product being broken.
    const seed = hashSeed(league.id, week, matchup.matchupId, Math.floor(now.getTime() / 60_000));

    const line = simulateMatchup(startersA, startersB, {
      iterations: options.iterations ?? 10_000,
      seed,
    });

    const phase: OddsSnapshot['phase'] = finished
      ? 'close'
      : startersA.concat(startersB).every((s) => s.gameStatus === 'pre')
        ? 'open'
        : 'live';

    const oddsSnapshot: OddsSnapshot = {
      capturedAt,
      phase,
      winProbA: line.winProbA,
      spread: line.spread,
      total: line.total,
      moneylineA: line.moneylineA,
      moneylineB: line.moneylineB,
      meanA: line.meanA,
      meanB: line.meanB,
      sdA: line.sdA,
      sdB: line.sdB,
      detail: {
        scoreA: matchup.a.score,
        scoreB: matchup.b.score,
        // Per-player points at capture time: the swing chart attributes a tick's
        // move to whoever gained the most between two snapshots, and there is no
        // other record of intermediate scoring to reconstruct that from.
        playerPoints: startedPoints(matchup),
      },
    };

    const row = await upsertMatchup({
      leagueId: league.id,
      week,
      matchupId: matchup.matchupId,
      rosterA: matchup.a.rosterId,
      rosterB: matchup.b.rosterId,
      pointsA: matchup.a.score,
      pointsB: matchup.b.score,
      status: finished ? 'final' : 'live',
    });

    await insertOddsSnapshot({ matchupRowId: row.id, snapshot: oddsSnapshot });
    snapshots.push(oddsSnapshot);
  }

  return { week, matchups: snapshots.length, snapshots, weekComplete: allFinal };
}

/**
 * Turn a team's started players into the odds engine's view.
 *
 * A player with points on the board is live; one with none is pre-game unless a
 * schedule source says otherwise. That heuristic is wrong for a genuine zero in
 * a finished game, which is why `gameProgress` exists and why supplying it is
 * the difference between a good live line and a rough one.
 */
export function toStarterStates(
  team: TeamWeek,
  players: Record<string, PlayerRef>,
  projections: Record<string, number>,
  context: { gameProgress?: Record<string, number>; nflOpponents?: Record<string, string> } = {},
): StarterState[] {
  const { gameProgress, nflOpponents } = context;
  const states: StarterState[] = [];

  for (const playerId of team.starters) {
    if (playerId === EMPTY_STARTER) continue;
    const player = players[playerId];
    if (!player) continue;

    const actual = team.points[playerId] ?? 0;
    const progress = player.team ? gameProgress?.[player.team] : undefined;

    let gameStatus: StarterState['gameStatus'];
    let gamePctElapsed: number;

    if (progress !== undefined) {
      gamePctElapsed = Math.min(Math.max(progress, 0), 1);
      gameStatus = gamePctElapsed >= 1 ? 'final' : gamePctElapsed <= 0 ? 'pre' : 'live';
    } else {
      gamePctElapsed = actual > 0 ? 0.5 : 0;
      gameStatus = actual > 0 ? 'live' : 'pre';
    }

    states.push({
      ...player,
      injuryStatus: player.injuryStatus,
      projection: projections[playerId] ?? fallbackProjection(player.position),
      actual,
      gameStatus,
      gamePctElapsed,
      opponentTeam: player.team ? nflOpponents?.[player.team] ?? null : null,
    });
  }

  return states;
}

/**
 * Positional replacement-level points, used only when no projection source is
 * configured. It makes the odds board work on Sleeper data alone at the cost of
 * treating every starter at a position as interchangeable — which is why the
 * UI labels a line built this way as an estimate.
 */
export function fallbackProjection(position: string): number {
  const defaults: Record<string, number> = {
    QB: 18, RB: 11, WR: 10, TE: 8, K: 8, DEF: 7,
    DL: 6, LB: 7, DB: 6,
  };
  return defaults[position] ?? 8;
}

function startedPoints(matchup: MatchupWeek): Record<string, number> {
  const out: Record<string, number> = {};
  const collect = (team: TeamWeek) => {
    for (const playerId of team.starters) {
      if (playerId === EMPTY_STARTER) continue;
      out[playerId] = team.points[playerId] ?? 0;
    }
  };
  collect(matchup.a);
  if (matchup.b) collect(matchup.b);
  return out;
}
