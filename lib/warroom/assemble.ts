import 'server-only';

import { playerDictionary } from '@/lib/sleeper/players';
import {
  listDraftPicks,
  listManagers,
  listRosters,
  listTendencies,
  listWatchlist,
  weekProjections,
  type LeagueRow,
} from '@/lib/db/queries';
import { deriveAdp, positionalMarket, type PositionalMarket } from './adp';
import { buildBoard, type Board } from './board';
import { byeCollisions, type ByeCollision, type RosterPlayer } from './needs';
import { liveWarnings, runDetector, type Tendency } from './tendencies';
import { historicalPicks, liveDraftState } from '@/lib/jobs/draft';

/**
 * Assemble everything the war room renders, from one pass over the data.
 *
 * The page is read-mostly and the pieces are interdependent — the run detector
 * needs the board's tiers, the warnings need the tendencies, the board needs the
 * roster — so gathering it in one place keeps the page component free of
 * orchestration.
 */

export type WarRoom = {
  board: Board;
  market: PositionalMarket[];
  collisions: ByeCollision[];
  warnings: string[];
  draft: {
    live: boolean;
    status: string | null;
    pickCount: number;
    /** Positional run state for the position this roster most needs. */
    run: ReturnType<typeof runDetector> | null;
    runPosition: string | null;
  };
  history: { seasons: string[]; picks: number };
  watchlistCount: number;
  myRosterId: number | null;
  /**
   * False when the player dictionary could not be loaded. Everything that names
   * a player degrades to ids, so the page says so rather than rendering a board
   * full of numbers.
   */
  playersAvailable: boolean;
};

export async function assembleWarRoom(
  league: LeagueRow,
  options: { rosterId?: number | null } = {},
): Promise<WarRoom> {
  // The dictionary lives behind Sleeper and a daily cron. When it is cold and
  // Sleeper is unreachable, the war room should explain that — not return a 500
  // because a name lookup failed.
  const dictionaryPromise = playerDictionary().catch(() => null);

  const [dictionaryOrNull, rosters, managers, storedPicks, watchlist, tendencyRows, projections] =
    await Promise.all([
      dictionaryPromise,
      listRosters(league.id),
      listManagers(league.id),
      listDraftPicks(league.id),
      listWatchlist(league.id),
      listTendencies(league.id),
      // Week 0 is the season-long total the draft board ranks on.
      weekProjections(league.season, 0),
    ]);

  const dictionary = dictionaryOrNull ?? {};
  const picks = await historicalPicks(league);

  // The roster being drafted for. Without an explicit choice, the first one is
  // a reasonable default for a single-user deployment.
  const myRoster = options.rosterId
    ? rosters.find((r) => r.roster_id === options.rosterId)
    : rosters[0];

  const roster: RosterPlayer[] = (myRoster?.players ?? []).map((playerId) => {
    const player = dictionary[playerId];
    return {
      playerId,
      position: player?.position ?? 'UNK',
      name: player?.name ?? playerId,
      byeWeek: player?.bye_week ?? null,
    };
  });

  // The live draft is the only part that must not fail the page: a draft that
  // has not started yet is the normal case for eleven months of the year.
  let live: Awaited<ReturnType<typeof liveDraftState>> = null;
  try {
    live = await liveDraftState(league);
  } catch {
    live = null;
  }

  const adp = deriveAdp(picks);
  const rosteredElsewhere = new Set(rosters.flatMap((r) => r.players));

  // With no dictionary, fall back to the players this room has actually
  // drafted: their names are gone but their ids, positions and ADP survive in
  // our own draft history, which is enough for a usable board.
  const fallbackPlayers = dictionaryOrNull
    ? []
    : [...new Map(picks.map((pick) => [pick.playerId, pick])).values()].map((pick) => ({
        id: pick.playerId,
        name: pick.playerId,
        position: pick.position,
        team: pick.nflTeam,
        bye_week: null as number | null,
        injury_status: null as string | null,
      }));

  const boardPlayers = [...Object.values(dictionary), ...fallbackPlayers]
    .filter((player) => ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].includes(player.position))
    // Without a value source, an 1,100-player board is noise. Anything with a
    // projection, a draft history in this room, or a roster spot is a real
    // candidate; the rest is practice squad.
    .filter(
      (player) =>
        projections[player.id] !== undefined ||
        adp.some((entry) => entry.playerId === player.id) ||
        rosteredElsewhere.has(player.id),
    )
    .map((player) => ({
      playerId: player.id,
      name: player.name,
      position: player.position,
      team: player.team,
      byeWeek: player.bye_week,
    }));

  const board = buildBoard({
    players: boardPlayers,
    projections,
    adp,
    taken: live?.taken,
    watchlist: Object.fromEntries(watchlist.map((item) => [item.player_id, { note: item.note }])),
    roster,
    rosterPositions: league.roster_positions,
    teams: rosters.length || 12,
  });

  const tendencies: Tendency[] = tendencyRows.map((row) => ({
    managerId: row.manager_id,
    metricKey: row.metric_key,
    value: Number(row.value),
    sampleSize: row.sample_size,
    detail: row.detail ?? {},
  }));

  const managerNames: Record<string, string> = {};
  for (const manager of managers) managerNames[manager.id] = manager.display_name;

  // Without a live draft there is no clock, so warnings are shown for the round
  // the draft has reached rather than a fabricated "picks away".
  const currentRound = live ? Math.floor(live.pickCount / (rosters.length || 12)) + 1 : 1;
  const picksAway: Record<string, number> = {};
  for (const manager of managers) picksAway[manager.id] = rosters.length || 12;

  const neediest = board.needs.find((need) => need.urgency > 0)?.position ?? null;
  const run =
    live && neediest
      ? runDetector({
          recentPicks: live.recentPositions,
          position: neediest,
          picksUntilYourTurn: rosters.length || 12,
          tierRemaining: board.players.filter(
            (player) => player.position === neediest && !player.taken && player.tier === 1,
          ).length,
        })
      : null;

  return {
    board,
    market: positionalMarket(picks),
    collisions: byeCollisions({ roster, rosterPositions: league.roster_positions }),
    warnings: liveWarnings({ tendencies, managerNames, picksAway, currentRound }),
    draft: {
      live: live?.status === 'drafting' || live?.status === 'paused',
      status: live?.status ?? null,
      pickCount: live?.pickCount ?? 0,
      run,
      runPosition: neediest,
    },
    history: {
      seasons: [...new Set(storedPicks.map((pick) => pick.season))].sort(),
      picks: storedPicks.length,
    },
    watchlistCount: watchlist.length,
    myRosterId: myRoster?.roster_id ?? null,
    playersAvailable: dictionaryOrNull !== null,
  };
}
