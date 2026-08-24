import 'server-only';

import { sleeper } from '@/lib/sleeper/client';
import { playerDictionary } from '@/lib/sleeper/players';
import type { SleeperMatchup } from '@/lib/sleeper/types';
import type { MatchupWeek, PlayerRef, TeamWeek } from '@/lib/compute/types';
import {
  listManagers,
  listRosters,
  upsertLeague,
  upsertManagers,
  upsertMatchup,
  upsertRosters,
  type LeagueRow,
  type ManagerRow,
} from '@/lib/db/queries';

/**
 * Ingestion. Sleeper's shapes go in, the app's shapes come out.
 *
 * Everything here fans out from one fetch per league per tick rather than one
 * per user session — that is the difference between a poller that scales to a
 * few thousand leagues inside Sleeper's rate limit and one that does not.
 */

export type ConnectResult = {
  league: LeagueRow;
  managers: ManagerRow[];
  rosterCount: number;
};

/**
 * Connect a league: pull its settings, users and rosters, and write them.
 * Idempotent, so it doubles as the daily refresh for league metadata.
 */
export async function connectLeague(
  sleeperLeagueId: string,
  ownerUserId?: string | null,
): Promise<ConnectResult> {
  const league = await sleeper.league(sleeperLeagueId);
  if (!league) throw new Error(`Sleeper has no league ${sleeperLeagueId}`);

  const row = await upsertLeague({
    sleeperLeagueId: league.league_id,
    season: league.season,
    name: league.name,
    scoringSettings: league.scoring_settings ?? {},
    rosterPositions: league.roster_positions ?? [],
    previousLeagueId: league.previous_league_id,
    ownerUserId,
  });

  const [users, rosters] = await Promise.all([
    sleeper.users(sleeperLeagueId),
    sleeper.rosters(sleeperLeagueId),
  ]);

  const managers = await upsertManagers(
    row.id,
    (users ?? []).map((user) => ({
      sleeperUserId: user.user_id,
      displayName: user.display_name,
      teamName: user.metadata?.team_name ?? null,
      avatar: user.avatar,
    })),
  );

  const managerBySleeperId = new Map(managers.map((m) => [m.sleeper_user_id, m.id]));

  await upsertRosters(
    row.id,
    (rosters ?? []).map((roster) => ({
      rosterId: roster.roster_id,
      managerId: roster.owner_id ? managerBySleeperId.get(roster.owner_id) ?? null : null,
      players: roster.players ?? [],
      starters: roster.starters ?? [],
      settings: (roster.settings ?? {}) as Record<string, number>,
    })),
  );

  return { league: row, managers, rosterCount: rosters?.length ?? 0 };
}

export type WeekSnapshot = {
  matchups: MatchupWeek[];
  players: Record<string, PlayerRef>;
  /** True once every matchup in the week has gone final. */
  allFinal: boolean;
};

/**
 * Pull one week's matchups and shape them into the compute layer's view.
 *
 * Sleeper returns one row per roster with a shared `matchup_id`; pairing them up
 * is on us. A roster whose `matchup_id` is null has no opponent that week.
 */
export async function fetchWeek(
  league: LeagueRow,
  week: number,
  options: { persist?: boolean; status?: 'pre' | 'live' | 'final' } = {},
): Promise<WeekSnapshot> {
  const raw = await sleeper.matchups(league.sleeper_league_id, week);
  const rows = raw ?? [];

  const [managers, rosters, dictionary] = await Promise.all([
    listManagers(league.id),
    listRosters(league.id),
    playerDictionary(),
  ]);

  const managerById = new Map(managers.map((m) => [m.id, m]));
  const rosterByRosterId = new Map(rosters.map((r) => [r.roster_id, r]));

  const teamByRosterId = new Map<number, TeamWeek>();
  for (const row of rows) {
    teamByRosterId.set(row.roster_id, toTeamWeek(row, rosterByRosterId, managerById));
  }

  // Group by Sleeper's matchup id. Two rosters share one; a bye roster has none.
  const grouped = new Map<number, SleeperMatchup[]>();
  const byes: SleeperMatchup[] = [];
  for (const row of rows) {
    if (row.matchup_id === null) byes.push(row);
    else {
      const list = grouped.get(row.matchup_id);
      if (list) list.push(row);
      else grouped.set(row.matchup_id, [row]);
    }
  }

  const matchups: MatchupWeek[] = [];
  for (const [matchupId, pair] of [...grouped.entries()].sort((x, y) => x[0] - y[0])) {
    const first = pair[0];
    if (!first) continue;
    const a = teamByRosterId.get(first.roster_id);
    if (!a) continue;
    const second = pair[1];
    const b = second ? teamByRosterId.get(second.roster_id) ?? null : null;
    matchups.push({ matchupId, a, b });
  }

  // Byes get a synthetic matchup id below the real ones so they sort first and
  // never collide with a Sleeper-assigned id.
  byes.forEach((row, i) => {
    const team = teamByRosterId.get(row.roster_id);
    if (team) matchups.push({ matchupId: -(i + 1), a: team, b: null });
  });

  const players: Record<string, PlayerRef> = {};
  for (const team of teamByRosterId.values()) {
    for (const playerId of team.players) {
      if (players[playerId]) continue;
      const lite = dictionary[playerId];
      players[playerId] = lite
        ? {
            id: lite.id,
            name: lite.name,
            position: lite.position,
            team: lite.team,
            injuryStatus: lite.injury_status,
          }
        : { id: playerId, name: playerId, position: 'UNK', team: null, injuryStatus: null };
    }
  }

  if (options.persist) {
    const status = options.status ?? 'live';
    for (const matchup of matchups) {
      await upsertMatchup({
        leagueId: league.id,
        week,
        matchupId: matchup.matchupId,
        rosterA: matchup.a.rosterId,
        rosterB: matchup.b?.rosterId ?? null,
        pointsA: matchup.a.score,
        pointsB: matchup.b?.score ?? 0,
        status,
      });
    }
  }

  return { matchups, players, allFinal: options.status === 'final' };
}

function toTeamWeek(
  row: SleeperMatchup,
  rosterByRosterId: Map<number, { manager_id: string | null; players: string[] }>,
  managerById: Map<string, ManagerRow>,
): TeamWeek {
  const roster = rosterByRosterId.get(row.roster_id);
  const manager = roster?.manager_id ? managerById.get(roster.manager_id) : undefined;

  // Sleeper's players_points covers everyone on the roster; starters_points is a
  // positional array we do not need once we have the map.
  const points = row.players_points ?? {};
  const players = row.players ?? roster?.players ?? [];

  return {
    rosterId: row.roster_id,
    managerId: manager?.id ?? `roster_${row.roster_id}`,
    manager: manager?.display_name ?? `Roster ${row.roster_id}`,
    teamName: manager?.team_name ?? manager?.display_name ?? `Roster ${row.roster_id}`,
    starters: row.starters ?? [],
    players,
    points,
    score: round2(row.custom_points ?? row.points ?? 0),
  };
}

/** Sleeper's transaction shape, reduced to what the compute layer reads. */
export async function fetchTransactions(league: LeagueRow, week: number) {
  const raw = await sleeper.transactions(league.sleeper_league_id, week);
  return (raw ?? [])
    .filter((transaction) => transaction.status === 'complete')
    .map((transaction) => ({
      transactionId: transaction.transaction_id,
      type: transaction.type,
      week,
      rosterIds: transaction.roster_ids ?? [],
      adds: transaction.adds ?? {},
      drops: transaction.drops ?? {},
      bid: transaction.settings?.waiver_bid ?? null,
    }));
}

/** Current NFL week and phase. Source of truth for every scheduled job. */
export async function currentState(): Promise<{ week: number; season: string; phase: string }> {
  const state = await sleeper.state('nfl');
  if (!state) throw new Error('Sleeper returned no NFL state');
  return { week: state.week, season: state.season, phase: state.season_type };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
