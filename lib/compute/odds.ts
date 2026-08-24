import { GammaQuantileTable, gammaFromMeanCv, normalCdf } from './gamma';
import { applyCholesky, cholesky, correlationMatrix } from './correlation';
import { hashSeed, mulberry32, type Rng } from './random';
import type { OddsLine, StarterState } from './types';

/**
 * The odds engine.
 *
 * There is no sportsbook for a head-to-head fantasy matchup, so these are
 * computed win probabilities rendered in a familiar format — we are the book.
 * The UI must label them "LeagueOps line", never "Vegas line", and no money
 * moves through the platform.
 */

/** Coefficient of variation by position, from historical fit. */
export const POSITION_CV: Record<string, number> = {
  QB: 0.35,
  RB: 0.55,
  WR: 0.65,
  TE: 0.7,
  K: 0.6,
  DEF: 0.75,
  DL: 0.6,
  LB: 0.5,
  DB: 0.55,
};

export const DEFAULT_CV = 0.6;

/** Minimum games before a per-player CV fit is trusted over the positional prior. */
export const MIN_CV_SAMPLE = 8;

/**
 * Probability a player with a given designation does not play. Zero-inflation:
 * a Questionable tag makes the outcome a mixture of `p(inactive) * 0` and
 * `(1 - p) * gamma`, which is a very different shape from simply shading the
 * mean down — and the difference shows up in the tails that decide matchups.
 */
export const INACTIVE_PROBABILITY: Record<string, number> = {
  OUT: 1,
  IR: 1,
  PUP: 1,
  SUS: 1,
  NA: 1,
  DOUBTFUL: 0.75,
  QUESTIONABLE: 0.25,
  PROBABLE: 0.05,
};

export function inactiveProbability(injuryStatus: string | null | undefined): number {
  if (!injuryStatus) return 0;
  return INACTIVE_PROBABILITY[injuryStatus.trim().toUpperCase()] ?? 0;
}

export function positionCv(position: string, fitted?: number | null): number {
  if (fitted != null && Number.isFinite(fitted) && fitted > 0) return fitted;
  return POSITION_CV[position] ?? DEFAULT_CV;
}

/**
 * A starter's contribution for this tick, reduced to what the sampler needs:
 * points already banked, plus a distribution over what is still to come.
 */
export type Contribution = {
  playerId: string;
  banked: number;
  /** Null when the player is done and there is nothing left to sample. */
  table: GammaQuantileTable | null;
  inactiveProb: number;
  meanRemaining: number;
};

/**
 * Split a starter into banked points and a remaining-points distribution.
 *
 * Variance scales with sqrt(remaining_share) rather than linearly: a player with
 * one quarter left retains more than a quarter of their outcome uncertainty,
 * because garbage-time touchdowns are real and a single score is a large
 * fraction of a weekly total.
 */
export function contributionFor(starter: StarterState): Contribution {
  const cv = positionCv(starter.position, starter.cv);

  if (starter.gameStatus === 'final') {
    return {
      playerId: starter.id,
      banked: starter.actual,
      table: null,
      inactiveProb: 0,
      meanRemaining: 0,
    };
  }

  if (starter.gameStatus === 'pre') {
    const mean = Math.max(starter.projection, 0.01);
    const params = gammaFromMeanCv(mean, cv);
    return {
      playerId: starter.id,
      banked: 0,
      table: new GammaQuantileTable(params.shape, params.scale),
      inactiveProb: inactiveProbability(starter.injuryStatus),
      meanRemaining: mean,
    };
  }

  const remainingShare = clamp(1 - starter.gamePctElapsed, 0, 1);
  const meanRemaining = Math.max(starter.projection * remainingShare, 0.01);
  const cvRemaining = cv * Math.sqrt(remainingShare);

  if (remainingShare <= 1e-6) {
    return {
      playerId: starter.id,
      banked: starter.actual,
      table: null,
      inactiveProb: 0,
      meanRemaining: 0,
    };
  }

  const params = gammaFromMeanCv(meanRemaining, cvRemaining);
  return {
    playerId: starter.id,
    banked: starter.actual,
    table: new GammaQuantileTable(params.shape, params.scale),
    // A player already on the field is playing; the injury mixture no longer
    // applies once they have banked snaps.
    inactiveProb: 0,
    meanRemaining,
  };
}

export type SimulationOptions = {
  iterations?: number;
  seed?: number;
  /** Set false to price without correlation, which is only useful for tests. */
  correlate?: boolean;
};

export type SimulationResult = OddsLine & {
  iterations: number;
  /** Sorted team totals, kept so callers can pull arbitrary percentiles. */
  distributionA: Float64Array;
  distributionB: Float64Array;
};

/**
 * Monte Carlo over closed form, because closed form cannot cleanly carry the
 * skew, the injury mixtures, and the correlation structure at the same time.
 */
export function simulateMatchup(
  startersA: StarterState[],
  startersB: StarterState[],
  options: SimulationOptions = {},
): SimulationResult {
  const iterations = options.iterations ?? 10_000;
  const correlate = options.correlate ?? true;
  const rng = mulberry32(options.seed ?? hashSeed('leagueops', startersA.length, startersB.length));

  const all = [...startersA, ...startersB];
  const contributions = all.map(contributionFor);
  const nA = startersA.length;

  const bankedA = sum(contributions.slice(0, nA).map((c) => c.banked));
  const bankedB = sum(contributions.slice(nA).map((c) => c.banked));

  const L = correlate && all.length > 0 ? cholesky(correlationMatrix(all)) : null;

  const totalsA = new Float64Array(iterations);
  const totalsB = new Float64Array(iterations);
  let winsA = 0;
  let ties = 0;

  const normals = new Array<number>(all.length).fill(0);

  for (let iter = 0; iter < iterations; iter += 1) {
    for (let i = 0; i < all.length; i += 1) normals[i] = rng.normal();
    const correlated = L ? applyCholesky(L, normals) : normals;

    let scoreA = bankedA;
    let scoreB = bankedB;

    for (let i = 0; i < contributions.length; i += 1) {
      const contribution = contributions[i] as Contribution;
      if (!contribution.table) continue;

      let drawn = 0;
      // The inactive draw is deliberately independent of the correlated normal:
      // whether a Questionable player is scratched has nothing to do with how
      // his quarterback throws.
      if (contribution.inactiveProb === 0 || rng.next() >= contribution.inactiveProb) {
        const u = normalCdf(correlated[i] as number);
        drawn = contribution.table.at(u);
      }

      if (i < nA) scoreA += drawn;
      else scoreB += drawn;
    }

    totalsA[iter] = scoreA;
    totalsB[iter] = scoreB;
    if (scoreA > scoreB) winsA += 1;
    else if (scoreA === scoreB) ties += 1;
  }

  // Split ties evenly. Exact ties are near-impossible with decimal scoring but
  // do occur in integer-scoring leagues.
  const winProbA = (winsA + ties / 2) / iterations;

  const margins = new Float64Array(iterations);
  const combined = new Float64Array(iterations);
  for (let i = 0; i < iterations; i += 1) {
    margins[i] = (totalsA[i] as number) - (totalsB[i] as number);
    combined[i] = (totalsA[i] as number) + (totalsB[i] as number);
  }

  const sortedA = Float64Array.from(totalsA).sort();
  const sortedB = Float64Array.from(totalsB).sort();

  return {
    winProbA: round4(winProbA),
    spread: round2(median(Float64Array.from(margins).sort())),
    total: round2(median(Float64Array.from(combined).sort())),
    moneylineA: probabilityToAmerican(winProbA),
    moneylineB: probabilityToAmerican(1 - winProbA),
    meanA: round2(mean(totalsA)),
    meanB: round2(mean(totalsB)),
    sdA: round2(stdev(totalsA)),
    sdB: round2(stdev(totalsB)),
    iterations,
    distributionA: sortedA,
    distributionB: sortedB,
  };
}

/**
 * Probability to American odds. This is a no-vig line and the UI says so —
 * there is no book taking the other side, so there is no juice to add.
 */
export function probabilityToAmerican(p: number): number {
  const clamped = clamp(p, 0.0001, 0.9999);
  if (clamped >= 0.5) return Math.round((-100 * clamped) / (1 - clamped));
  return Math.round((100 * (1 - clamped)) / clamped);
}

export function formatAmerican(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

/** Spread as shown on a card: the favourite carries the negative number. */
export function formatSpread(spread: number, nameA: string, nameB: string): string {
  if (Math.abs(spread) < 0.05) return 'PK';
  return spread > 0 ? `${nameA} -${round2(spread)}` : `${nameB} -${round2(Math.abs(spread))}`;
}

/**
 * Win probability added by a lineup change — the number that makes a start/sit
 * recommendation actionable. "+6.2% to win" beats "+2.1 projected points",
 * because points only matter relative to the opponent's distribution.
 */
export function winProbabilityAdded(params: {
  starters: StarterState[];
  opponent: StarterState[];
  swapOut: string;
  swapIn: StarterState;
  options?: SimulationOptions;
}): number {
  const { starters, opponent, swapOut, swapIn, options } = params;
  const seed = options?.seed ?? hashSeed('wpa', swapOut, swapIn.id);
  // Both sims share a seed so the difference is the lineup change, not sampling
  // noise — without this, a 1% edge disappears under Monte Carlo error.
  const before = simulateMatchup(starters, opponent, { ...options, seed, iterations: options?.iterations ?? 4_000 });
  const after = simulateMatchup(
    starters.map((s) => (s.id === swapOut ? swapIn : s)),
    opponent,
    { ...options, seed, iterations: options?.iterations ?? 4_000 },
  );
  return round4(after.winProbA - before.winProbA);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

function mean(values: Float64Array): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < values.length; i += 1) total += values[i] as number;
  return total / values.length;
}

function stdev(values: Float64Array): number {
  if (values.length < 2) return 0;
  const mu = mean(values);
  let acc = 0;
  for (let i = 0; i < values.length; i += 1) {
    const d = (values[i] as number) - mu;
    acc += d * d;
  }
  return Math.sqrt(acc / (values.length - 1));
}

/** Median of an already-sorted array. */
function median(sorted: Float64Array): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid] as number;
  return (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export const __testing = { mean, stdev, median };
