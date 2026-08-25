/**
 * Shapes returned by the Sleeper read-only API (https://docs.sleeper.com).
 * Sleeper returns untyped JSON and is generous with nulls; every field that has
 * ever been observed missing is optional here rather than trusted.
 */

export type SleeperState = {
  week: number;
  season: string;
  season_type: 'pre' | 'regular' | 'post' | 'off';
  display_week?: number;
  league_season?: string;
  season_start_date?: string;
};

export type SleeperLeague = {
  league_id: string;
  name: string;
  season: string;
  status: string;
  sport: string;
  total_rosters: number;
  previous_league_id: string | null;
  draft_id: string | null;
  scoring_settings: Record<string, number>;
  roster_positions: string[];
  settings: Record<string, number>;
  avatar: string | null;
};

export type SleeperUser = {
  user_id: string;
  display_name: string;
  avatar: string | null;
  metadata?: {
    team_name?: string | null;
    [k: string]: unknown;
  } | null;
};

export type SleeperRoster = {
  roster_id: number;
  owner_id: string | null;
  co_owners: string[] | null;
  league_id: string;
  players: string[] | null;
  starters: string[] | null;
  reserve: string[] | null;
  taxi: string[] | null;
  settings: {
    wins: number;
    losses: number;
    ties: number;
    fpts?: number;
    fpts_decimal?: number;
    fpts_against?: number;
    fpts_against_decimal?: number;
    [k: string]: number | undefined;
  };
};

export type SleeperMatchup = {
  roster_id: number;
  /** Null in weeks a roster has no opponent (byes in odd-sized leagues). */
  matchup_id: number | null;
  points: number;
  custom_points: number | null;
  players: string[] | null;
  starters: string[] | null;
  /** player_id -> fantasy points, per the league's own scoring settings. */
  players_points: Record<string, number> | null;
  starters_points: number[] | null;
};

export type SleeperTransaction = {
  transaction_id: string;
  type: 'trade' | 'free_agent' | 'waiver';
  status: string;
  status_updated: number;
  leg: number;
  roster_ids: number[];
  adds: Record<string, number> | null;
  drops: Record<string, number> | null;
  draft_picks: unknown[];
  waiver_budget: unknown[];
  settings: { waiver_bid?: number; seq?: number } | null;
};

export type SleeperPlayer = {
  player_id: string;
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  position?: string | null;
  fantasy_positions?: string[] | null;
  team?: string | null;
  injury_status?: string | null;
  status?: string | null;
  active?: boolean;
  bye_week?: number | string | null;
};

export type SleeperDraft = {
  draft_id: string;
  league_id: string;
  season: string;
  status: string;
  type: string;
  start_time: number | null;
  settings: Record<string, number>;
  draft_order: Record<string, number> | null;
  slot_to_roster_id: Record<string, number> | null;
};

export type SleeperDraftPick = {
  draft_id: string;
  player_id: string;
  picked_by: string;
  roster_id: number | null;
  round: number;
  draft_slot: number;
  pick_no: number;
  metadata?: Record<string, string> | null;
};

export type SleeperTrendingPlayer = {
  player_id: string;
  count: number;
};

/**
 * The reduced player record. This — not the raw 10MB dictionary — is what is
 * allowed to leave the server. See lib/sleeper/players.ts.
 */
export type PlayerLite = {
  id: string;
  name: string;
  position: string;
  team: string | null;
  injury_status: string | null;
  /** Sleeper reports this inconsistently, so it is optional everywhere. */
  bye_week: number | null;
};
