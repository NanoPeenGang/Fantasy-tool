import type { AllPlayRecord } from './types';

/**
 * Season-level derived metrics. All of these run on Sleeper data alone — no
 * projections, no external dependency — which is why they ship before the odds
 * engine does.
 */

export type WeekScore = {
  week: number;
  rosterId: number;
  score: number;
  /** Opponent roster id, or null on a bye week. */
  opponentRosterId: number | null;
  opponentScore: number | null;
};

export type SeasonHistory = {
  /** Every scored week for every roster, in any order. */
  weeks: WeekScore[];
};

/**
 * All-play record: score against every other team every week.
 *
 * The cleanest talent measure available without projections, because it strips
 * the schedule out entirely. A team can be 2-5 and 40-15 all-play, and that gap
 * is the most argued-about number in the product.
 */
export function allPlayRecord(history: SeasonHistory, rosterId: number, throughWeek?: number): AllPlayRecord {
  const record: AllPlayRecord = { w: 0, l: 0, t: 0 };
  const byWeek = groupByWeek(history.weeks, throughWeek);

  for (const [, scores] of byWeek) {
    const own = scores.find((s) => s.rosterId === rosterId);
    if (!own) continue;
    for (const other of scores) {
      if (other.rosterId === rosterId) continue;
      if (own.score > other.score) record.w += 1;
      else if (own.score < other.score) record.l += 1;
      else record.t += 1;
    }
  }
  return record;
}

export function allPlayWinRate(record: AllPlayRecord): number {
  const games = record.w + record.l + record.t;
  if (games === 0) return 0;
  return (record.w + record.t / 2) / games;
}

/** Head-to-head record from the schedule as actually played. */
export function headToHeadRecord(
  history: SeasonHistory,
  rosterId: number,
  throughWeek?: number,
): { w: number; l: number; t: number; pf: number; pa: number } {
  const out = { w: 0, l: 0, t: 0, pf: 0, pa: 0 };
  for (const week of history.weeks) {
    if (week.rosterId !== rosterId) continue;
    if (throughWeek !== undefined && week.week > throughWeek) continue;
    out.pf += week.score;
    if (week.opponentRosterId === null || week.opponentScore === null) continue;
    out.pa += week.opponentScore;
    if (week.score > week.opponentScore) out.w += 1;
    else if (week.score < week.opponentScore) out.l += 1;
    else out.t += 1;
  }
  out.pf = round2(out.pf);
  out.pa = round2(out.pa);
  return out;
}

/**
 * Luck index: actual wins minus all-play expected wins.
 *
 * Positive means the schedule has been kind — you have beaten the teams you
 * happened to draw while scoring like a worse team. This is the stat that starts
 * arguments, which is the point of shipping it.
 */
export function luckIndex(history: SeasonHistory, rosterId: number, throughWeek?: number): number {
  const allPlay = allPlayRecord(history, rosterId, throughWeek);
  const h2h = headToHeadRecord(history, rosterId, throughWeek);
  const gamesPlayed = h2h.w + h2h.l + h2h.t;
  const expectedWins = allPlayWinRate(allPlay) * gamesPlayed;
  const actualWins = h2h.w + h2h.t / 2;
  return round2(actualWins - expectedWins);
}

export type PowerInput = {
  rosterId: number;
  allPlayWinRate: number;
  /** Mean score over the most recent three scored weeks. */
  recentMean: number;
  /** Sum of rest-of-season projections for the roster; 0 when unavailable. */
  rosterStrength: number;
  pointsFor: number;
};

export type PowerWeights = {
  allPlay: number;
  recent: number;
  rosterStrength: number;
  pointsFor: number;
};

export const POWER_WEIGHTS: PowerWeights = {
  allPlay: 0.4,
  recent: 0.25,
  rosterStrength: 0.2,
  pointsFor: 0.15,
};

/**
 * Power score: a weighted composite, normalised within the league so the number
 * is comparable week to week. Weights are a starting point to be tuned after a
 * season of data, not a fitted model.
 *
 * When no projection source is configured, roster strength is unavailable for
 * everyone; rather than feeding zeros into the composite and silently shrinking
 * every score, its weight is redistributed across the other three components.
 */
export function powerScores(inputs: PowerInput[]): { rosterId: number; powerScore: number; powerRank: number }[] {
  if (inputs.length === 0) return [];

  const hasRosterStrength = inputs.some((i) => i.rosterStrength > 0);
  const weights = hasRosterStrength
    ? POWER_WEIGHTS
    : redistribute(POWER_WEIGHTS, 'rosterStrength');

  const recent = normalize(inputs.map((i) => i.recentMean));
  const strength = normalize(inputs.map((i) => i.rosterStrength));
  const pf = normalize(inputs.map((i) => i.pointsFor));

  const scored = inputs.map((input, i) => {
    const composite =
      weights.allPlay * input.allPlayWinRate +
      weights.recent * (recent[i] as number) +
      weights.rosterStrength * (strength[i] as number) +
      weights.pointsFor * (pf[i] as number);
    return { rosterId: input.rosterId, powerScore: round1(composite * 100) };
  });

  const ranked = [...scored].sort((a, b) => b.powerScore - a.powerScore);
  const rankByRoster = new Map(ranked.map((entry, index) => [entry.rosterId, index + 1]));

  return scored.map((entry) => ({
    ...entry,
    powerRank: rankByRoster.get(entry.rosterId) ?? 0,
  }));
}

function redistribute(weights: PowerWeights, drop: keyof PowerWeights): PowerWeights {
  const remaining = 1 - weights[drop];
  const out = { ...weights };
  for (const key of Object.keys(weights) as (keyof PowerWeights)[]) {
    out[key] = key === drop ? 0 : weights[key] / remaining;
  }
  return out;
}

/** Min-max to [0, 1] within the league. A flat slate maps to 0.5 for everyone. */
function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min < 1e-9) return values.map(() => 0.5);
  return values.map((v) => (v - min) / (max - min));
}

export function recentMean(history: SeasonHistory, rosterId: number, throughWeek: number, span = 3): number {
  const scores = history.weeks
    .filter((w) => w.rosterId === rosterId && w.week <= throughWeek)
    .sort((a, b) => b.week - a.week)
    .slice(0, span)
    .map((w) => w.score);
  if (scores.length === 0) return 0;
  return round2(scores.reduce((a, b) => a + b, 0) / scores.length);
}

export function seasonMoments(
  history: SeasonHistory,
  rosterId: number,
  throughWeek?: number,
): { mean: number; sd: number } {
  const scores = history.weeks
    .filter((w) => w.rosterId === rosterId && (throughWeek === undefined || w.week <= throughWeek))
    .map((w) => w.score);
  if (scores.length === 0) return { mean: 0, sd: 0 };
  const mu = scores.reduce((a, b) => a + b, 0) / scores.length;
  if (scores.length < 2) return { mean: round2(mu), sd: 0 };
  const variance = scores.reduce((acc, s) => acc + (s - mu) ** 2, 0) / (scores.length - 1);
  return { mean: round2(mu), sd: round2(Math.sqrt(variance)) };
}

function groupByWeek(weeks: WeekScore[], throughWeek?: number): Map<number, WeekScore[]> {
  const map = new Map<number, WeekScore[]>();
  for (const week of weeks) {
    if (throughWeek !== undefined && week.week > throughWeek) continue;
    const list = map.get(week.week);
    if (list) list.push(week);
    else map.set(week.week, [week]);
  }
  return map;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
