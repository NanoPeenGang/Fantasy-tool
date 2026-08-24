import 'server-only';

import { query, queryOne } from './client';
import type {
  Award,
  OddsSnapshot,
  StatPacket,
  Storyline,
} from '@/lib/compute/types';
import type { SeasonHistory } from '@/lib/compute/standings';

/**
 * Repository layer. Every SQL statement in the app lives here so the shape of
 * the database is changeable in one place, and so the route handlers and jobs
 * read as the sequence of steps they are.
 */

export type LeagueRow = {
  id: string;
  sleeper_league_id: string;
  season: string;
  name: string;
  scoring_settings: Record<string, number>;
  roster_positions: string[];
  previous_league_id: string | null;
  heat_ceiling: string;
  voice_preset: string;
  delivery_config: Record<string, unknown>;
  owner_user_id: string | null;
};

export type ManagerRow = {
  id: string;
  league_id: string;
  sleeper_user_id: string;
  display_name: string;
  team_name: string | null;
  avatar: string | null;
  roast_opt_down: boolean;
  persona_notes: string | null;
};

export type RosterRow = {
  id: string;
  league_id: string;
  roster_id: number;
  manager_id: string | null;
  players: string[];
  starters: string[];
  settings: Record<string, number>;
};

export type MatchupRow = {
  id: string;
  league_id: string;
  week: number;
  matchup_id: number;
  roster_a: number;
  roster_b: number | null;
  points_a: string | number;
  points_b: string | number;
  status: 'pre' | 'live' | 'final';
};

// --- leagues ---------------------------------------------------------------

export async function findLeague(sleeperLeagueId: string, season: string): Promise<LeagueRow | null> {
  return queryOne<LeagueRow>(
    'SELECT * FROM leagues WHERE sleeper_league_id = $1 AND season = $2',
    [sleeperLeagueId, season],
  );
}

export async function getLeague(leagueId: string): Promise<LeagueRow | null> {
  return queryOne<LeagueRow>('SELECT * FROM leagues WHERE id = $1', [leagueId]);
}

export async function listLeagues(): Promise<LeagueRow[]> {
  return query<LeagueRow>('SELECT * FROM leagues ORDER BY connected_at DESC');
}

export async function upsertLeague(input: {
  sleeperLeagueId: string;
  season: string;
  name: string;
  scoringSettings: Record<string, number>;
  rosterPositions: string[];
  previousLeagueId: string | null;
  ownerUserId?: string | null;
}): Promise<LeagueRow> {
  const row = await queryOne<LeagueRow>(
    `INSERT INTO leagues
       (sleeper_league_id, season, name, scoring_settings, roster_positions,
        previous_league_id, owner_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (sleeper_league_id, season) DO UPDATE SET
       name = EXCLUDED.name,
       scoring_settings = EXCLUDED.scoring_settings,
       roster_positions = EXCLUDED.roster_positions,
       previous_league_id = EXCLUDED.previous_league_id
     RETURNING *`,
    [
      input.sleeperLeagueId,
      input.season,
      input.name,
      JSON.stringify(input.scoringSettings),
      JSON.stringify(input.rosterPositions),
      input.previousLeagueId,
      input.ownerUserId ?? null,
    ],
  );
  if (!row) throw new Error('Failed to upsert league');
  return row;
}

export async function updateLeagueSettings(
  leagueId: string,
  settings: { heatCeiling?: string; voicePreset?: string; deliveryConfig?: Record<string, unknown> },
): Promise<void> {
  await query(
    `UPDATE leagues SET
       heat_ceiling = COALESCE($2, heat_ceiling),
       voice_preset = COALESCE($3, voice_preset),
       delivery_config = COALESCE($4, delivery_config)
     WHERE id = $1`,
    [
      leagueId,
      settings.heatCeiling ?? null,
      settings.voicePreset ?? null,
      settings.deliveryConfig ? JSON.stringify(settings.deliveryConfig) : null,
    ],
  );
}

// --- managers and rosters --------------------------------------------------

export async function upsertManagers(
  leagueId: string,
  managers: { sleeperUserId: string; displayName: string; teamName: string | null; avatar: string | null }[],
): Promise<ManagerRow[]> {
  const rows: ManagerRow[] = [];
  for (const manager of managers) {
    const row = await queryOne<ManagerRow>(
      `INSERT INTO managers (league_id, sleeper_user_id, display_name, team_name, avatar)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (league_id, sleeper_user_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         team_name = EXCLUDED.team_name,
         avatar = EXCLUDED.avatar
       RETURNING *`,
      [leagueId, manager.sleeperUserId, manager.displayName, manager.teamName, manager.avatar],
    );
    if (row) rows.push(row);
  }
  return rows;
}

export async function listManagers(leagueId: string): Promise<ManagerRow[]> {
  return query<ManagerRow>('SELECT * FROM managers WHERE league_id = $1 ORDER BY display_name', [leagueId]);
}

export async function setRoastOptDown(managerId: string, optDown: boolean): Promise<void> {
  await query('UPDATE managers SET roast_opt_down = $2 WHERE id = $1', [managerId, optDown]);
}

export async function upsertRosters(
  leagueId: string,
  rosters: { rosterId: number; managerId: string | null; players: string[]; starters: string[]; settings: Record<string, number> }[],
): Promise<void> {
  for (const roster of rosters) {
    await query(
      `INSERT INTO rosters (league_id, roster_id, manager_id, players, starters, settings, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (league_id, roster_id) DO UPDATE SET
         manager_id = EXCLUDED.manager_id,
         players = EXCLUDED.players,
         starters = EXCLUDED.starters,
         settings = EXCLUDED.settings,
         updated_at = now()`,
      [
        leagueId,
        roster.rosterId,
        roster.managerId,
        JSON.stringify(roster.players),
        JSON.stringify(roster.starters),
        JSON.stringify(roster.settings),
      ],
    );
  }
}

export async function listRosters(leagueId: string): Promise<RosterRow[]> {
  return query<RosterRow>('SELECT * FROM rosters WHERE league_id = $1 ORDER BY roster_id', [leagueId]);
}

// --- matchups and season history -------------------------------------------

export async function upsertMatchup(input: {
  leagueId: string;
  week: number;
  matchupId: number;
  rosterA: number;
  rosterB: number | null;
  pointsA: number;
  pointsB: number;
  status: 'pre' | 'live' | 'final';
}): Promise<MatchupRow> {
  const row = await queryOne<MatchupRow>(
    `INSERT INTO matchups (league_id, week, matchup_id, roster_a, roster_b, points_a, points_b, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (league_id, week, matchup_id) DO UPDATE SET
       roster_a = EXCLUDED.roster_a,
       roster_b = EXCLUDED.roster_b,
       points_a = EXCLUDED.points_a,
       points_b = EXCLUDED.points_b,
       status = EXCLUDED.status,
       updated_at = now()
     RETURNING *`,
    [
      input.leagueId, input.week, input.matchupId, input.rosterA, input.rosterB,
      input.pointsA, input.pointsB, input.status,
    ],
  );
  if (!row) throw new Error('Failed to upsert matchup');
  return row;
}

export async function listMatchups(leagueId: string, week: number): Promise<MatchupRow[]> {
  return query<MatchupRow>(
    'SELECT * FROM matchups WHERE league_id = $1 AND week = $2 ORDER BY matchup_id',
    [leagueId, week],
  );
}

/**
 * Season history for the all-play and luck calculations, assembled from the
 * matchup rows we have already stored. Each stored matchup yields two rows —
 * one per roster, each seeing the other as its opponent.
 */
export async function seasonHistory(leagueId: string, throughWeek: number): Promise<SeasonHistory> {
  const rows = await query<MatchupRow>(
    `SELECT * FROM matchups
     WHERE league_id = $1 AND week <= $2 AND status = 'final'
     ORDER BY week, matchup_id`,
    [leagueId, throughWeek],
  );

  const weeks: SeasonHistory['weeks'] = [];
  for (const row of rows) {
    const pointsA = Number(row.points_a);
    const pointsB = Number(row.points_b);
    weeks.push({
      week: row.week,
      rosterId: row.roster_a,
      score: pointsA,
      opponentRosterId: row.roster_b,
      opponentScore: row.roster_b === null ? null : pointsB,
    });
    if (row.roster_b !== null) {
      weeks.push({
        week: row.week,
        rosterId: row.roster_b,
        score: pointsB,
        opponentRosterId: row.roster_a,
        opponentScore: pointsA,
      });
    }
  }
  return { weeks };
}

// --- odds snapshots --------------------------------------------------------

export async function insertOddsSnapshot(input: {
  matchupRowId: string;
  snapshot: OddsSnapshot;
}): Promise<void> {
  const { snapshot } = input;
  await query(
    `INSERT INTO odds_snapshots
       (matchup_id, captured_at, win_prob_a, spread, total, moneyline_a, moneyline_b, phase, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.matchupRowId,
      snapshot.capturedAt,
      snapshot.winProbA,
      snapshot.spread,
      snapshot.total,
      snapshot.moneylineA,
      snapshot.moneylineB,
      snapshot.phase,
      JSON.stringify(snapshot.detail ?? {}),
    ],
  );
}

type OddsRow = {
  matchup_id: string;
  captured_at: Date;
  win_prob_a: string;
  spread: string;
  total: string;
  moneyline_a: number;
  moneyline_b: number;
  phase: 'open' | 'live' | 'close';
  detail: OddsSnapshot['detail'];
  sleeper_matchup_id: number;
};

/** Every persisted tick for a week, keyed by Sleeper's matchup id. */
export async function oddsByMatchup(
  leagueId: string,
  week: number,
): Promise<Record<number, OddsSnapshot[]>> {
  const rows = await query<OddsRow>(
    `SELECT o.*, m.matchup_id AS sleeper_matchup_id
     FROM odds_snapshots o
     JOIN matchups m ON m.id = o.matchup_id
     WHERE m.league_id = $1 AND m.week = $2
     ORDER BY o.captured_at`,
    [leagueId, week],
  );

  const out: Record<number, OddsSnapshot[]> = {};
  for (const row of rows) {
    const snapshot: OddsSnapshot = {
      capturedAt: new Date(row.captured_at).toISOString(),
      phase: row.phase,
      winProbA: Number(row.win_prob_a),
      spread: Number(row.spread),
      total: Number(row.total),
      moneylineA: row.moneyline_a,
      moneylineB: row.moneyline_b,
      meanA: 0,
      meanB: 0,
      sdA: 0,
      sdB: 0,
      detail: row.detail ?? undefined,
    };
    (out[row.sleeper_matchup_id] ??= []).push(snapshot);
  }
  return out;
}

// --- stat packets ----------------------------------------------------------

export async function saveStatPacket(leagueId: string, week: number, packet: StatPacket): Promise<void> {
  await query(
    `INSERT INTO stat_packets (league_id, week, payload, computed_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (league_id, week) DO UPDATE SET
       payload = EXCLUDED.payload, computed_at = now()`,
    [leagueId, week, JSON.stringify(packet)],
  );
}

export async function getStatPacket(leagueId: string, week: number): Promise<StatPacket | null> {
  const row = await queryOne<{ payload: StatPacket }>(
    'SELECT payload FROM stat_packets WHERE league_id = $1 AND week = $2',
    [leagueId, week],
  );
  return row?.payload ?? null;
}

export async function listStatPackets(leagueId: string): Promise<{ week: number; packet: StatPacket }[]> {
  const rows = await query<{ week: number; payload: StatPacket }>(
    'SELECT week, payload FROM stat_packets WHERE league_id = $1 ORDER BY week',
    [leagueId],
  );
  return rows.map((row) => ({ week: row.week, packet: row.payload }));
}

export async function latestPacketWeek(leagueId: string): Promise<number | null> {
  const row = await queryOne<{ week: number }>(
    'SELECT max(week) AS week FROM stat_packets WHERE league_id = $1',
    [leagueId],
  );
  return row?.week ?? null;
}

// --- awards ----------------------------------------------------------------

export async function saveAwards(leagueId: string, week: number, awards: Award[], managerIdByName: Record<string, string>): Promise<void> {
  for (const award of awards) {
    await query(
      `INSERT INTO awards (league_id, week, award_key, manager_id, value, evidence)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (league_id, week, award_key) DO UPDATE SET
         manager_id = EXCLUDED.manager_id, value = EXCLUDED.value, evidence = EXCLUDED.evidence`,
      [
        leagueId, week, award.key,
        managerIdByName[award.manager] ?? null,
        award.value, JSON.stringify(award.evidence),
      ],
    );
  }
}

// --- storylines ------------------------------------------------------------

type StorylineRow = {
  thread_key: string;
  summary: string;
  first_week: number;
  last_referenced_week: number;
  status: 'live' | 'resolved' | 'retired';
  manager_ids: string[];
};

export async function listStorylines(leagueId: string, season: string): Promise<Storyline[]> {
  const rows = await query<StorylineRow>(
    'SELECT * FROM storylines WHERE league_id = $1 AND season = $2',
    [leagueId, season],
  );
  return rows.map((row) => ({
    threadKey: row.thread_key,
    summary: row.summary,
    sinceWeek: row.first_week,
    lastReferencedWeek: row.last_referenced_week,
    status: row.status,
    managerIds: row.manager_ids ?? [],
  }));
}

export async function saveStorylines(
  leagueId: string,
  season: string,
  storylines: Storyline[],
): Promise<void> {
  for (const thread of storylines) {
    await query(
      `INSERT INTO storylines
         (league_id, season, thread_key, summary, first_week, last_referenced_week, status, manager_ids, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (league_id, season, thread_key) DO UPDATE SET
         summary = EXCLUDED.summary,
         last_referenced_week = EXCLUDED.last_referenced_week,
         status = EXCLUDED.status,
         manager_ids = EXCLUDED.manager_ids,
         updated_at = now()`,
      [
        leagueId, season, thread.threadKey, thread.summary, thread.sinceWeek,
        thread.lastReferencedWeek, thread.status, JSON.stringify(thread.managerIds),
      ],
    );
  }
}

// --- reports ---------------------------------------------------------------

export async function saveReport(input: {
  leagueId: string;
  week: number;
  kind: 'aar' | 'commissioner';
  variant: string;
  body: string;
  factCheckStatus: Record<string, unknown>;
}): Promise<void> {
  await query(
    `INSERT INTO reports (league_id, week, kind, variant, body, fact_check_status, generated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (league_id, week, kind, variant) DO UPDATE SET
       body = EXCLUDED.body,
       fact_check_status = EXCLUDED.fact_check_status,
       generated_at = now()`,
    [input.leagueId, input.week, input.kind, input.variant, input.body, JSON.stringify(input.factCheckStatus)],
  );
}

export async function getReport(
  leagueId: string,
  week: number,
  kind: 'aar' | 'commissioner',
  variant = '',
): Promise<{ body: string; fact_check_status: Record<string, unknown>; generated_at: Date } | null> {
  return queryOne(
    'SELECT body, fact_check_status, generated_at FROM reports WHERE league_id = $1 AND week = $2 AND kind = $3 AND variant = $4',
    [leagueId, week, kind, variant],
  );
}

// --- projections -----------------------------------------------------------

export async function weekProjections(
  season: string,
  week: number,
  source?: string,
): Promise<Record<string, number>> {
  const rows = source
    ? await query<{ player_id: string; mean: string }>(
        'SELECT player_id, mean FROM projections WHERE season = $1 AND week = $2 AND source = $3',
        [season, week, source],
      )
    : await query<{ player_id: string; mean: string }>(
        `SELECT DISTINCT ON (player_id) player_id, mean
         FROM projections WHERE season = $1 AND week = $2
         ORDER BY player_id, updated_at DESC`,
        [season, week],
      );

  const out: Record<string, number> = {};
  for (const row of rows) out[row.player_id] = Number(row.mean);
  return out;
}

export async function upsertProjections(
  season: string,
  week: number,
  source: string,
  projections: { playerId: string; mean: number; sd?: number | null }[],
): Promise<void> {
  for (const projection of projections) {
    await query(
      `INSERT INTO projections (player_id, season, week, source, mean, sd, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (player_id, season, week, source) DO UPDATE SET
         mean = EXCLUDED.mean, sd = EXCLUDED.sd, updated_at = now()`,
      [projection.playerId, season, week, source, projection.mean, projection.sd ?? null],
    );
  }
}
