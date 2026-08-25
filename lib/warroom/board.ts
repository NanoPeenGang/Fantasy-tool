import { computeTiers, valueOverReplacement, type AdpEntry } from './adp';
import { positionalNeeds, startersByPosition, type PositionalNeed, type RosterPlayer } from './needs';

/**
 * The draft board.
 *
 * Ranked against this league's own scoring settings, tiered by where the value
 * actually falls off, and weighted by what this roster still needs — not the
 * generic board every site shows.
 */

export type BoardPlayer = {
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  byeWeek: number | null;
  /** Projected points under this league's scoring, when a source exists. */
  projection: number | null;
  /** Points above the last startable player at the position. */
  vor: number | null;
  /** Average draft position, from whichever source is active. */
  adp: number | null;
  adpStdev: number | null;
  /** 1 is the top tier at this position. */
  tier: number | null;
  /** True once someone has taken them in the live draft. */
  taken: boolean;
  takenBy: string | null;
  takenAtPick: number | null;
  onWatchlist: boolean;
  watchNote: string | null;
  /** How much this roster needs the position, 0 to 1. */
  need: number;
  /** Ranking score after need weighting. Higher is a better pick for you. */
  score: number;
};

/** Where the board's ordering came from. Shown in the UI, never guessed at. */
export type ValueSource = 'projections' | 'league_adp' | 'none';

export type BoardInput = {
  players: {
    playerId: string;
    name: string;
    position: string;
    team: string | null;
    byeWeek?: number | null;
  }[];
  /** Player id -> projected points, already scored for this league. */
  projections?: Record<string, number>;
  adp?: AdpEntry[];
  /** Player id -> { by, pick } for players already drafted. */
  taken?: Record<string, { by: string; pick: number }>;
  watchlist?: Record<string, { note: string | null }>;
  roster: RosterPlayer[];
  rosterPositions: string[];
  teams: number;
  /**
   * How hard need weighting pushes. 0 ranks on raw value, 1 lets need dominate.
   * The default deliberately leaves value in charge — drafting for need in
   * round two is how rosters end up bad everywhere at once.
   */
  needWeight?: number;
};

export type Board = {
  players: BoardPlayer[];
  source: ValueSource;
  needs: PositionalNeed[];
  /** Cliffs per position: where the tier below is meaningfully worse. */
  cliffsByPosition: Record<string, { startsAtIndex: number; gap: number }[]>;
};

export function buildBoard(input: BoardInput): Board {
  const needWeight = input.needWeight ?? 0.25;
  const needs = positionalNeeds({ roster: input.roster, rosterPositions: input.rosterPositions });
  const needByPosition = new Map(needs.map((need) => [need.position, need.urgency]));

  const projections = input.projections ?? {};
  const hasProjections = Object.keys(projections).length > 0;
  const adpByPlayer = new Map((input.adp ?? []).map((entry) => [entry.playerId, entry]));
  const source: ValueSource = hasProjections
    ? 'projections'
    : adpByPlayer.size > 0
      ? 'league_adp'
      : 'none';

  const vor = hasProjections
    ? valueOverReplacement({
        players: input.players.map((player) => ({
          playerId: player.playerId,
          position: player.position,
          projection: projections[player.playerId] ?? 0,
        })),
        startersByPosition: startersByPosition(input.rosterPositions),
        teams: input.teams,
      })
    : {};

  const rows: BoardPlayer[] = input.players.map((player) => {
    const adpEntry = adpByPlayer.get(player.playerId);
    const takenEntry = input.taken?.[player.playerId];
    const watch = input.watchlist?.[player.playerId];

    return {
      playerId: player.playerId,
      name: player.name,
      position: player.position,
      team: player.team,
      byeWeek: player.byeWeek ?? null,
      projection: hasProjections ? projections[player.playerId] ?? null : null,
      vor: hasProjections ? vor[player.playerId] ?? null : null,
      adp: adpEntry?.adp ?? null,
      adpStdev: adpEntry?.stdev ?? null,
      tier: null,
      taken: Boolean(takenEntry),
      takenBy: takenEntry?.by ?? null,
      takenAtPick: takenEntry?.pick ?? null,
      onWatchlist: Boolean(watch),
      watchNote: watch?.note ?? null,
      need: needByPosition.get(player.position) ?? 0,
      score: 0,
    };
  });

  // Rank on value over replacement where projections exist, since it is the only
  // number that compares across positions. Otherwise fall back to ADP, where a
  // lower pick number is better and so is negated to keep "higher is better".
  const baseValue = (row: BoardPlayer): number => {
    if (source === 'projections') return row.vor ?? 0;
    if (source === 'league_adp') return row.adp === null ? -9999 : -row.adp;
    return 0;
  };

  const values = rows.map(baseValue);
  const spread = Math.max(...values) - Math.min(...values);
  for (const row of rows) {
    // Need is a nudge scaled to the board's own spread, so its influence does
    // not depend on whether values are points or pick numbers.
    row.score = round2(baseValue(row) + (spread > 0 ? needWeight * row.need * spread * 0.1 : 0));
  }

  rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  // Tiers are computed per position: a cross-positional tier tells you nothing
  // about whether to take a running back now, which is the actual question.
  const cliffsByPosition: Record<string, { startsAtIndex: number; gap: number }[]> = {};
  const byPosition = new Map<string, BoardPlayer[]>();
  for (const row of rows) {
    const list = byPosition.get(row.position) ?? [];
    list.push(row);
    byPosition.set(row.position, list);
  }

  for (const [position, positionRows] of byPosition) {
    if (source === 'none') continue;
    const { tiers, cliffs } = computeTiers(positionRows.map(baseValue));
    positionRows.forEach((row, index) => {
      row.tier = tiers[index] ?? 1;
    });
    if (cliffs.length > 0) cliffsByPosition[position] = cliffs;
  }

  return { players: rows, source, needs, cliffsByPosition };
}

/**
 * How many players remain in a tier — the number the run detector needs, and
 * the one that turns "three backs went" into "and there are two left".
 */
export function tierRemaining(board: Board, position: string, tier: number): number {
  return board.players.filter(
    (player) => player.position === position && player.tier === tier && !player.taken,
  ).length;
}

/** Best available at each position, ignoring anyone already drafted. */
export function bestAvailable(board: Board, limit = 5): BoardPlayer[] {
  return board.players.filter((player) => !player.taken).slice(0, limit);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
