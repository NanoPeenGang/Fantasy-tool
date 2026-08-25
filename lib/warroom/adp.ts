import type { HistoricalPick } from './tendencies';

/**
 * Draft value: average draft position, and the tier cliffs that actually drive
 * decisions.
 *
 * Sleeper publishes no ADP endpoint, so a board needs a value source and there
 * are only two honest ones:
 *
 *   1. Projections, imported from wherever you get them, re-scored against this
 *      league's own scoring settings. Best when available.
 *   2. This league's own draft history, chained back through previous_league_id.
 *      Costs nothing, needs no vendor, and is arguably the more useful number —
 *      value is relative to the room you are drafting in, not to a national
 *      consensus that does not play in your league.
 *
 * Neither is invented. When a league has neither, the board says so instead of
 * inventing a ranking.
 */

export type AdpEntry = {
  playerId: string;
  /** Mean overall pick number across the drafts this player appeared in. */
  adp: number;
  /** Spread of those picks. High means the room disagrees about them. */
  stdev: number;
  earliest: number;
  latest: number;
  /** How many drafts this is based on. One is an anecdote, not an ADP. */
  sampleSize: number;
  position: string;
};

/**
 * Average draft position from this league's own history.
 *
 * Recent seasons are weighted more heavily: a player taken in the third round
 * two years ago and the eighth round last year is on the way down, and a flat
 * mean hides that. The weight halves per season back, which is aggressive
 * enough to track a real decline without letting one season erase the rest.
 */
export function deriveAdp(picks: HistoricalPick[], options: { halfLifeSeasons?: number } = {}): AdpEntry[] {
  const halfLife = options.halfLifeSeasons ?? 1;
  const seasons = [...new Set(picks.map((pick) => pick.season))].sort();
  const latestSeason = seasons[seasons.length - 1];
  if (!latestSeason) return [];

  const byPlayer = new Map<string, HistoricalPick[]>();
  for (const pick of picks) {
    const list = byPlayer.get(pick.playerId) ?? [];
    list.push(pick);
    byPlayer.set(pick.playerId, list);
  }

  const entries: AdpEntry[] = [];
  for (const [playerId, playerPicks] of byPlayer) {
    let weightSum = 0;
    let weighted = 0;
    for (const pick of playerPicks) {
      const seasonsBack = Number(latestSeason) - Number(pick.season);
      const weight = Number.isFinite(seasonsBack) ? 0.5 ** (seasonsBack / halfLife) : 1;
      weighted += pick.pickNo * weight;
      weightSum += weight;
    }

    const adp = weightSum > 0 ? weighted / weightSum : 0;
    const picksNo = playerPicks.map((pick) => pick.pickNo);
    const mean = picksNo.reduce((a, b) => a + b, 0) / picksNo.length;
    const variance =
      picksNo.length < 2
        ? 0
        : picksNo.reduce((acc, value) => acc + (value - mean) ** 2, 0) / (picksNo.length - 1);

    entries.push({
      playerId,
      adp: round2(adp),
      stdev: round2(Math.sqrt(variance)),
      earliest: Math.min(...picksNo),
      latest: Math.max(...picksNo),
      sampleSize: playerPicks.length,
      position: playerPicks[0]?.position ?? 'UNK',
    });
  }

  return entries.sort((a, b) => a.adp - b.adp);
}

/**
 * The positional market of this room: which round each position typically comes
 * off the board, and how early the first one goes.
 *
 * This is the prep number that survives roster turnover. Players change every
 * year; the fact that this league lets tight ends fall to round nine does not.
 */
export type PositionalMarket = {
  position: string;
  /** Mean round of the first player taken at this position, per draft. */
  firstOffBoardRound: number;
  /** Mean round across every pick at the position. */
  meanRound: number;
  /** Rounds by which most of the startable ones are gone. */
  medianRound: number;
  count: number;
  drafts: number;
};

export function positionalMarket(picks: HistoricalPick[]): PositionalMarket[] {
  const byPosition = new Map<string, HistoricalPick[]>();
  for (const pick of picks) {
    const list = byPosition.get(pick.position) ?? [];
    list.push(pick);
    byPosition.set(pick.position, list);
  }

  const out: PositionalMarket[] = [];
  for (const [position, positionPicks] of byPosition) {
    const draftIds = [...new Set(positionPicks.map((p) => p.draftId))];

    const firstRounds = draftIds.map((draftId) =>
      Math.min(...positionPicks.filter((p) => p.draftId === draftId).map((p) => p.round)),
    );
    const rounds = positionPicks.map((p) => p.round).sort((a, b) => a - b);

    out.push({
      position,
      firstOffBoardRound: round2(firstRounds.reduce((a, b) => a + b, 0) / firstRounds.length),
      meanRound: round2(rounds.reduce((a, b) => a + b, 0) / rounds.length),
      medianRound: rounds[Math.floor(rounds.length / 2)] ?? 0,
      count: positionPicks.length,
      drafts: draftIds.length,
    });
  }

  return out.sort((a, b) => a.firstOffBoardRound - b.firstOffBoardRound);
}

export type TierResult = {
  /** 1-based tier per input index. */
  tiers: number[];
  /** Gap size at each tier boundary, keyed by the index the new tier starts at. */
  cliffs: { startsAtIndex: number; gap: number }[];
};

/**
 * Tier detection by cliff.
 *
 * Ordering within a tier is noise; the gap between tiers is the decision. The
 * useful question at pick 9 is not "who is ranked 9th" but "does the tier run
 * out before my next pick", so the board shows where the floor drops rather
 * than a ranked list that implies precision it does not have.
 *
 * Cliffs are found with a robust threshold — median gap plus a multiple of the
 * median absolute deviation — because a mean-and-standard-deviation threshold is
 * dragged upward by the very cliffs it is trying to find.
 */
export function computeTiers(
  /** Player values, best first. Projected points, or negated ADP. */
  values: number[],
  options: { sensitivity?: number; minTierSize?: number; maxTiers?: number } = {},
): TierResult {
  const sensitivity = options.sensitivity ?? 1.5;
  const minTierSize = options.minTierSize ?? 2;
  const maxTiers = options.maxTiers ?? 12;

  if (values.length === 0) return { tiers: [], cliffs: [] };
  if (values.length === 1) return { tiers: [1], cliffs: [] };

  const gaps: number[] = [];
  for (let i = 0; i < values.length - 1; i += 1) {
    gaps.push(Math.max(0, (values[i] as number) - (values[i + 1] as number)));
  }

  const median = medianOf(gaps);
  const deviations = gaps.map((gap) => Math.abs(gap - median));
  const mad = medianOf(deviations);
  // A perfectly even board has no cliffs; require a positive spread before
  // calling anything a break, or every gap becomes a tier boundary.
  const threshold = mad > 0 ? median + sensitivity * mad : median * (1 + sensitivity);

  const tiers = new Array<number>(values.length).fill(1);
  const cliffs: { startsAtIndex: number; gap: number }[] = [];

  let tier = 1;
  let sizeInTier = 1;

  for (let i = 0; i < gaps.length; i += 1) {
    const gap = gaps[i] as number;
    const nextIndex = i + 1;
    const isCliff = gap > threshold && gap > 0;

    if (isCliff && sizeInTier >= minTierSize && tier < maxTiers) {
      tier += 1;
      sizeInTier = 1;
      cliffs.push({ startsAtIndex: nextIndex, gap: round2(gap) });
    } else {
      sizeInTier += 1;
    }
    tiers[nextIndex] = tier;
  }

  return { tiers, cliffs };
}

/**
 * Value over replacement: a player's projection minus what the last startable
 * player at that position is worth.
 *
 * This is what makes cross-position comparison meaningful. Twelve points from a
 * quarterback in a league that starts one is worth far less than twelve from a
 * flex, and a raw projection ranking hides that completely.
 */
export function valueOverReplacement(params: {
  players: { playerId: string; position: string; projection: number }[];
  /** Starting slots by position, e.g. { QB: 1, RB: 2, WR: 2, TE: 1 }. */
  startersByPosition: Record<string, number>;
  teams: number;
}): Record<string, number> {
  const byPosition = new Map<string, number[]>();
  for (const player of params.players) {
    const list = byPosition.get(player.position) ?? [];
    list.push(player.projection);
    byPosition.set(player.position, list);
  }

  const replacement: Record<string, number> = {};
  for (const [position, projections] of byPosition) {
    const sorted = [...projections].sort((a, b) => b - a);
    const startersNeeded = (params.startersByPosition[position] ?? 0) * params.teams;
    // The replacement is the first player who will not start anywhere, so a
    // position nobody starts has a replacement level of its own best player.
    const index = Math.max(0, Math.min(startersNeeded, sorted.length - 1));
    replacement[position] = sorted[index] ?? 0;
  }

  const out: Record<string, number> = {};
  for (const player of params.players) {
    out[player.playerId] = round2(player.projection - (replacement[player.position] ?? 0));
  }
  return out;
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
