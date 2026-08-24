import type { PlayerRef } from './types';

/**
 * Optimal lineup solver.
 *
 * This is maximum-weight bipartite matching, not greedy sorting. Greedy fails on
 * flex eligibility in a way that is easy to miss and always favourable-looking:
 * it fills FLEX with the best remaining WR, then finds the WR2 slot empty. The
 * problem is tiny (at most ~30 players x ~11 slots) so we solve it exactly.
 *
 * Used three ways, all from here:
 *   - prospective, weights = projections  -> start/sit
 *   - retroactive, weights = actual points -> coaching efficiency, bench regret
 *   - league-wide, all rosters pooled      -> team of the week
 */

/** Slots that never hold a scoring player. */
const NON_SCORING_SLOTS = new Set(['BN', 'IR', 'TAXI']);

/**
 * Which positions may fill which slot. Keys are Sleeper roster_positions labels.
 * A slot not listed here accepts only players whose position equals the label,
 * which covers QB/RB/WR/TE/K/DEF and the plain IDP slots.
 */
export const SLOT_ELIGIBILITY: Record<string, string[]> = {
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  IDP_FLEX: ['DL', 'LB', 'DB', 'DE', 'DT', 'CB', 'S'],
  DL: ['DL', 'DE', 'DT'],
  DB: ['DB', 'CB', 'S'],
  LB: ['LB'],
};

export function isScoringSlot(slot: string): boolean {
  return !NON_SCORING_SLOTS.has(slot);
}

export function slotAccepts(slot: string, position: string): boolean {
  const eligible = SLOT_ELIGIBILITY[slot];
  if (eligible) return eligible.includes(position);
  return slot === position;
}

/** The scoring slots of a league, in roster_positions order. */
export function scoringSlots(rosterPositions: string[]): string[] {
  return rosterPositions.filter(isScoringSlot);
}

export type SolveInput = {
  /** Candidate players. For the retroactive solve this is the whole roster. */
  players: PlayerRef[];
  /** Weight per player id: projected points, or actual points. */
  weights: Record<string, number>;
  /** The league's roster_positions, including BN/IR which are filtered out. */
  rosterPositions: string[];
};

export type SolvedSlot = {
  slot: string;
  slotIndex: number;
  player: PlayerRef | null;
  points: number;
};

export type SolveResult = {
  slots: SolvedSlot[];
  total: number;
  /** Player ids that ended up in the optimal lineup. */
  startedIds: string[];
};

/**
 * Solve the optimal lineup. Slots with no eligible player are left empty rather
 * than forcing an illegal assignment, which is why the cost matrix is padded
 * with zero-weight dummy columns.
 */
export function solveOptimalLineup(input: SolveInput): SolveResult {
  const slots = scoringSlots(input.rosterPositions);
  const players = input.players;

  if (slots.length === 0) {
    return { slots: [], total: 0, startedIds: [] };
  }

  const n = slots.length;
  const realCols = players.length;
  // One dummy column per slot guarantees a feasible assignment even when no
  // real player is eligible anywhere.
  const m = realCols + n;

  // Hungarian minimises, so costs are negated weights. Ineligible pairs get a
  // penalty larger than any achievable total, never Infinity — the potentials
  // in the algorithm would go non-finite and poison every subsequent row.
  const maxWeight = Math.max(1, ...Object.values(input.weights).map((w) => Math.abs(w) || 0));
  const INELIGIBLE = maxWeight * (n + 1) * 10 + 1_000;

  const cost: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    const slot = slots[i] as string;
    const row = new Array<number>(m);
    for (let j = 0; j < realCols; j += 1) {
      const player = players[j] as PlayerRef;
      row[j] = slotAccepts(slot, player.position)
        ? -(input.weights[player.id] ?? 0)
        : INELIGIBLE;
    }
    for (let j = realCols; j < m; j += 1) row[j] = 0; // empty slot scores nothing
    cost[i] = row;
  }

  const assignment = hungarian(cost);

  const solved: SolvedSlot[] = [];
  const startedIds: string[] = [];
  let total = 0;

  for (let i = 0; i < n; i += 1) {
    const col = assignment[i] as number;
    const slot = slots[i] as string;
    if (col < 0 || col >= realCols || (cost[i] as number[])[col] === INELIGIBLE) {
      solved.push({ slot, slotIndex: i, player: null, points: 0 });
      continue;
    }
    const player = players[col] as PlayerRef;
    const points = input.weights[player.id] ?? 0;
    total += points;
    startedIds.push(player.id);
    solved.push({ slot, slotIndex: i, player, points });
  }

  return { slots: solved, total: round2(total), startedIds };
}

export type CoachingReport = {
  actual: number;
  optimal: number;
  efficiency: number;
  benchPointsLeft: number;
  optimalLineup: SolvedSlot[];
  /**
   * Bench players who should have started, worst regret first, each paired with
   * the started player they would have replaced.
   */
  regrets: {
    benchPlayer: PlayerRef;
    benchPoints: number;
    replacing: PlayerRef | null;
    replacingPoints: number;
    delta: number;
    slot: string;
  }[];
};

/**
 * Retroactive coaching report: what the manager scored against what the roster
 * they already owned could have scored.
 *
 * `benchPointsLeft` is optimal minus actual, not the raw sum of bench scores —
 * a 30-point bench WR is not 30 points left behind if there was nowhere legal to
 * put them.
 */
export function coachingReport(params: {
  roster: PlayerRef[];
  started: string[];
  points: Record<string, number>;
  rosterPositions: string[];
}): CoachingReport {
  const { roster, started, points, rosterPositions } = params;

  const optimal = solveOptimalLineup({ players: roster, weights: points, rosterPositions });
  const actual = round2(started.reduce((sum, id) => sum + (points[id] ?? 0), 0));

  const startedSet = new Set(started);
  const optimalSet = new Set(optimal.startedIds);

  // A regret pairs a player who should have started with the one who did. We
  // pair them by slot so the counterfactual names a legal swap.
  const shouldHaveStarted = optimal.slots.filter(
    (s) => s.player !== null && !startedSet.has(s.player.id),
  );
  const shouldNotHave = started
    .filter((id) => !optimalSet.has(id))
    .map((id) => ({ id, points: points[id] ?? 0 }))
    .sort((x, y) => x.points - y.points);

  const regrets = shouldHaveStarted
    .map((slot, i) => {
      const displaced = shouldNotHave[i];
      const replacing = displaced ? roster.find((p) => p.id === displaced.id) ?? null : null;
      const replacingPoints = displaced?.points ?? 0;
      return {
        benchPlayer: slot.player as PlayerRef,
        benchPoints: round2(slot.points),
        replacing,
        replacingPoints: round2(replacingPoints),
        delta: round2(slot.points - replacingPoints),
        slot: slot.slot,
      };
    })
    .sort((x, y) => y.delta - x.delta);

  const efficiency = optimal.total > 0 ? actual / optimal.total : 1;

  return {
    actual,
    optimal: optimal.total,
    efficiency: round4(efficiency),
    benchPointsLeft: round2(Math.max(0, optimal.total - actual)),
    optimalLineup: optimal.slots,
    regrets,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Rectangular Hungarian algorithm (Jonker-Volgenant style shortest augmenting
 * paths with potentials), O(n^2 m) for an n x m cost matrix with n <= m.
 * Returns, per row, the column assigned to it.
 */
export function hungarian(cost: number[][]): number[] {
  const n = cost.length;
  if (n === 0) return [];
  const m = (cost[0] as number[]).length;
  if (m < n) throw new Error(`hungarian: needs at least as many columns as rows (${n} x ${m})`);

  const INF = Number.POSITIVE_INFINITY;
  // 1-indexed working arrays, per the standard formulation; index 0 is the
  // virtual source used to start each augmenting path.
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0); // column -> row
  const way = new Array<number>(m + 1).fill(0);

  for (let i = 1; i <= n; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(INF);
    const used = new Array<boolean>(m + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0] as number;
      let delta = INF;
      let j1 = 0;

      for (let j = 1; j <= m; j += 1) {
        if (used[j]) continue;
        const cur = (cost[i0 - 1] as number[])[j - 1]! - (u[i0] as number) - (v[j] as number);
        if (cur < (minv[j] as number)) {
          minv[j] = cur;
          way[j] = j0;
        }
        if ((minv[j] as number) < delta) {
          delta = minv[j] as number;
          j1 = j;
        }
      }

      for (let j = 0; j <= m; j += 1) {
        if (used[j]) {
          u[p[j] as number] = (u[p[j] as number] as number) + delta;
          v[j] = (v[j] as number) - delta;
        } else {
          minv[j] = (minv[j] as number) - delta;
        }
      }

      j0 = j1;
    } while ((p[j0] as number) !== 0);

    do {
      const j1 = way[j0] as number;
      p[j0] = p[j1] as number;
      j0 = j1;
    } while (j0 !== 0);
  }

  const assignment = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j += 1) {
    const row = p[j] as number;
    if (row > 0) assignment[row - 1] = j - 1;
  }
  return assignment;
}
