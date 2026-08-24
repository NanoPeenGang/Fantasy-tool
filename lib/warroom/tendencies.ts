/**
 * Draft tendency mining.
 *
 * The war room's genuine edge, and the one thing no other tool has: not what
 * players are worth, but what *these eleven people* do. Chaining back through
 * `previous_league_id` gives several years of the same room drafting, which is
 * enough to say "Dave has taken a QB in round 3 in four straight drafts, and he
 * picks in six".
 *
 * Pure functions over historical picks, so this is testable without a draft.
 */

export type HistoricalPick = {
  season: string;
  draftId: string;
  managerId: string;
  playerId: string;
  position: string;
  nflTeam: string | null;
  round: number;
  pickNo: number;
  /** Consensus ADP at the time, when available. Reach rate needs it. */
  adp?: number | null;
};

export type Tendency = {
  managerId: string;
  metricKey: string;
  value: number;
  sampleSize: number;
  detail: Record<string, unknown>;
};

/**
 * Average round at which a manager first takes each position. The number that
 * powers the live warning, because it is the one that predicts the next pick.
 */
export function firstPickRoundByPosition(picks: HistoricalPick[]): Tendency[] {
  const byManagerPosition = new Map<string, Map<string, number[]>>();

  // First pick of each position, per manager per draft.
  const seen = new Set<string>();
  for (const pick of [...picks].sort((a, b) => a.pickNo - b.pickNo)) {
    const key = `${pick.managerId}|${pick.draftId}|${pick.position}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const positions = byManagerPosition.get(pick.managerId) ?? new Map<string, number[]>();
    const rounds = positions.get(pick.position) ?? [];
    rounds.push(pick.round);
    positions.set(pick.position, rounds);
    byManagerPosition.set(pick.managerId, positions);
  }

  const tendencies: Tendency[] = [];
  for (const [managerId, positions] of byManagerPosition) {
    for (const [position, rounds] of positions) {
      tendencies.push({
        managerId,
        metricKey: `first_${position.toLowerCase()}_round`,
        value: round2(rounds.reduce((a, b) => a + b, 0) / rounds.length),
        sampleSize: rounds.length,
        detail: { rounds, position },
      });
    }
  }
  return tendencies;
}

/**
 * Reach rate: how often a manager takes a player meaningfully ahead of ADP, and
 * by how much on average. Needs ADP, so it is silently absent without one.
 */
export function reachRate(picks: HistoricalPick[], threshold = 12): Tendency[] {
  const byManager = new Map<string, HistoricalPick[]>();
  for (const pick of picks) {
    if (pick.adp === null || pick.adp === undefined) continue;
    const list = byManager.get(pick.managerId) ?? [];
    list.push(pick);
    byManager.set(pick.managerId, list);
  }

  const tendencies: Tendency[] = [];
  for (const [managerId, managerPicks] of byManager) {
    if (managerPicks.length === 0) continue;
    // A reach is taking someone whose ADP is later than the pick used on them.
    const reaches = managerPicks.filter((pick) => (pick.adp as number) - pick.pickNo > threshold);
    const averageDelta =
      managerPicks.reduce((sum, pick) => sum + ((pick.adp as number) - pick.pickNo), 0) /
      managerPicks.length;

    tendencies.push({
      managerId,
      metricKey: 'reach_rate',
      value: round4(reaches.length / managerPicks.length),
      sampleSize: managerPicks.length,
      detail: {
        averagePicksAheadOfAdp: round2(averageDelta),
        biggestReach: reaches.sort((a, b) => (b.adp as number) - b.pickNo - ((a.adp as number) - a.pickNo))[0]?.playerId ?? null,
      },
    });
  }
  return tendencies;
}

/** Share of a manager's picks spent on each position. */
export function positionalBias(picks: HistoricalPick[]): Tendency[] {
  const byManager = new Map<string, HistoricalPick[]>();
  for (const pick of picks) {
    const list = byManager.get(pick.managerId) ?? [];
    list.push(pick);
    byManager.set(pick.managerId, list);
  }

  const tendencies: Tendency[] = [];
  for (const [managerId, managerPicks] of byManager) {
    const counts = new Map<string, number>();
    for (const pick of managerPicks) {
      counts.set(pick.position, (counts.get(pick.position) ?? 0) + 1);
    }
    for (const [position, count] of counts) {
      tendencies.push({
        managerId,
        metricKey: `bias_${position.toLowerCase()}`,
        value: round4(count / managerPicks.length),
        sampleSize: managerPicks.length,
        detail: { count, position },
      });
    }
  }
  return tendencies;
}

/**
 * NFL-team homerism: the team a manager drafts from far more than chance would
 * suggest. With 32 teams, anything above ~15% of picks is a tell.
 */
export function teamHomerism(picks: HistoricalPick[]): Tendency[] {
  const byManager = new Map<string, HistoricalPick[]>();
  for (const pick of picks) {
    if (!pick.nflTeam) continue;
    const list = byManager.get(pick.managerId) ?? [];
    list.push(pick);
    byManager.set(pick.managerId, list);
  }

  const tendencies: Tendency[] = [];
  for (const [managerId, managerPicks] of byManager) {
    if (managerPicks.length < 5) continue;
    const counts = new Map<string, number>();
    for (const pick of managerPicks) {
      counts.set(pick.nflTeam as string, (counts.get(pick.nflTeam as string) ?? 0) + 1);
    }

    const [team, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] as [string, number];
    const share = count / managerPicks.length;

    tendencies.push({
      managerId,
      metricKey: 'team_homerism',
      value: round4(share),
      sampleSize: managerPicks.length,
      detail: { team, count, isNotable: share > 0.15 },
    });
  }
  return tendencies;
}

export function mineTendencies(picks: HistoricalPick[]): Tendency[] {
  return [
    ...firstPickRoundByPosition(picks),
    ...reachRate(picks),
    ...positionalBias(picks),
    ...teamHomerism(picks),
  ];
}

/**
 * Live warnings for the board: what this manager is about to do, and how soon.
 * Only fires on tendencies with enough history to be worth saying out loud —
 * a warning drawn from one prior draft is noise that costs trust.
 */
export function liveWarnings(params: {
  tendencies: Tendency[];
  managerNames: Record<string, string>;
  /** Manager id -> picks until they are on the clock. */
  picksAway: Record<string, number>;
  currentRound: number;
  minSample?: number;
}): string[] {
  const minSample = params.minSample ?? 3;
  const warnings: string[] = [];

  for (const tendency of params.tendencies) {
    if (tendency.sampleSize < minSample) continue;

    const name = params.managerNames[tendency.managerId];
    const away = params.picksAway[tendency.managerId];
    if (!name || away === undefined) continue;

    const positionMatch = /^first_(\w+)_round$/.exec(tendency.metricKey);
    if (positionMatch && Math.abs(tendency.value - params.currentRound) < 1) {
      const position = (positionMatch[1] as string).toUpperCase();
      warnings.push(
        `${name} has taken a ${position} in round ${Math.round(tendency.value)} across ${tendency.sampleSize} drafts. They pick in ${away}.`,
      );
      continue;
    }

    if (tendency.metricKey === 'team_homerism' && tendency.detail.isNotable) {
      warnings.push(
        `${name} spends ${Math.round(tendency.value * 100)}% of their picks on ${tendency.detail.team}. They pick in ${away}.`,
      );
    }
  }

  return warnings;
}

/**
 * Positional run detection with survival odds.
 *
 * "Three RBs in the last five picks. Six picks until you're up — 71% chance the
 * last tier-2 RB is gone." The rate is estimated from the recent window rather
 * than assumed, because a run is exactly the situation where the base rate is
 * wrong.
 */
export function runDetector(params: {
  /** Positions of recent picks, most recent last. */
  recentPicks: string[];
  position: string;
  /** How many picks until the user is on the clock. */
  picksUntilYourTurn: number;
  /** Players left in the tier the user cares about. */
  tierRemaining: number;
  windowSize?: number;
}): { runDetected: boolean; recentCount: number; rate: number; survivalProbability: number } {
  const window = params.windowSize ?? 5;
  const recent = params.recentPicks.slice(-window);
  const recentCount = recent.filter((position) => position === params.position).length;

  // A run is that position taking more than half a short window.
  const runDetected = recent.length >= 3 && recentCount / recent.length > 0.5;

  const rate = recent.length === 0 ? 0 : recentCount / recent.length;

  // Each of the intervening picks independently takes one of the tier at `rate`.
  // Crude, and honest about it: it ignores that a depleting tier slows its own
  // rate, so it errs toward urgency.
  const expectedTaken = rate * params.picksUntilYourTurn;
  const survivalProbability =
    params.tierRemaining <= 0
      ? 0
      : Math.min(1, Math.max(0, 1 - poissonAtLeast(expectedTaken, params.tierRemaining)));

  return {
    runDetected,
    recentCount,
    rate: round4(rate),
    survivalProbability: round4(survivalProbability),
  };
}

/** P(X >= k) for X ~ Poisson(lambda). */
function poissonAtLeast(lambda: number, k: number): number {
  if (k <= 0) return 1;
  let cumulative = 0;
  let term = Math.exp(-lambda);
  for (let i = 0; i < k; i += 1) {
    cumulative += term;
    term = (term * lambda) / (i + 1);
  }
  return Math.min(1, Math.max(0, 1 - cumulative));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
