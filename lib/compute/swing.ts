import type { OddsSnapshot } from './types';

/**
 * Swing chart metrics.
 *
 * Persisting every odds snapshot produces a win-probability curve per matchup,
 * and that curve is the richest source of material in the product: every metric
 * below is a computed number that becomes an award, an AAR headline, and a
 * paragraph in the recap. This is where the analytical half and the
 * entertainment half meet.
 */

export type SwingMetrics = {
  /** Highest win probability each side reached at any tick. */
  peakA: { value: number; at: string } | null;
  peakB: { value: number; at: string } | null;
  /** Largest single-tick probability delta, and the player it is attributed to. */
  biggestSwing: {
    delta: number;
    at: string;
    /** Signed toward A: positive means the swing favoured A. */
    towardA: boolean;
    playerId: string | null;
    playerPoints: number;
  } | null;
  /**
   * The winner's minimum win probability at any point. Below 0.10 is a genuine
   * heist; this is what the Heist of the Week award ranks on.
   */
  comebackIndex: number | null;
  /**
   * True when the loser never got above 25% at any tick — the game was over
   * before it started. The complement of comebackIndex, and what tells the
   * recap to give this matchup two sentences instead of six.
   */
  deadOnArrival: boolean;
  /** When the outcome stopped being in doubt. */
  clinchAt: string | null;
  /** True when the side that closed as underdog won. */
  closingUpset: boolean;
  /** The opening line, for "was favoured and lost" claims. */
  opening: OddsSnapshot | null;
  final: OddsSnapshot | null;
};

const CLINCH_THRESHOLD = 0.99;
const DOA_THRESHOLD = 0.25;

/**
 * @param snapshots every persisted tick for one matchup, any order
 * @param winner    which side actually won, or 'tie'
 */
export function swingMetrics(snapshots: OddsSnapshot[], winner: 'a' | 'b' | 'tie'): SwingMetrics {
  const ticks = [...snapshots].sort(
    (x, y) => new Date(x.capturedAt).getTime() - new Date(y.capturedAt).getTime(),
  );

  if (ticks.length === 0) {
    return {
      peakA: null, peakB: null, biggestSwing: null, comebackIndex: null,
      deadOnArrival: false, clinchAt: null, closingUpset: false, opening: null, final: null,
    };
  }

  const opening = ticks[0] as OddsSnapshot;
  const final = ticks[ticks.length - 1] as OddsSnapshot;

  let peakA: { value: number; at: string } | null = null;
  let peakB: { value: number; at: string } | null = null;

  for (const tick of ticks) {
    if (!peakA || tick.winProbA > peakA.value) peakA = { value: tick.winProbA, at: tick.capturedAt };
    const probB = 1 - tick.winProbA;
    if (!peakB || probB > peakB.value) peakB = { value: probB, at: tick.capturedAt };
  }

  const biggestSwing = findBiggestSwing(ticks);

  // The winner's low-water mark. A tie has no comeback story.
  let comebackIndex: number | null = null;
  if (winner !== 'tie') {
    let min = 1;
    for (const tick of ticks) {
      const prob = winner === 'a' ? tick.winProbA : 1 - tick.winProbA;
      if (prob < min) min = prob;
    }
    comebackIndex = round4(min);
  }

  // Measured on the loser: the winner's peak is 1 by the final tick in every
  // completed matchup, so it carries no information.
  const loserPeak = winner === 'a' ? peakB?.value ?? 1 : winner === 'b' ? peakA?.value ?? 1 : 1;
  const deadOnArrival = winner !== 'tie' && loserPeak <= DOA_THRESHOLD;

  return {
    peakA,
    peakB,
    biggestSwing,
    comebackIndex,
    deadOnArrival,
    clinchAt: findClinch(ticks, winner),
    closingUpset: isClosingUpset(opening, winner),
    opening,
    final,
  };
}

function findBiggestSwing(ticks: OddsSnapshot[]): SwingMetrics['biggestSwing'] {
  if (ticks.length < 2) return null;

  let best: SwingMetrics['biggestSwing'] = null;

  for (let i = 1; i < ticks.length; i += 1) {
    const previous = ticks[i - 1] as OddsSnapshot;
    const current = ticks[i] as OddsSnapshot;
    const delta = current.winProbA - previous.winProbA;
    const magnitude = Math.abs(delta);
    if (best && magnitude <= best.delta) continue;

    const attribution = attributeSwing(previous, current);
    best = {
      delta: round4(magnitude),
      at: current.capturedAt,
      towardA: delta > 0,
      playerId: attribution.playerId,
      playerPoints: attribution.points,
    };
  }

  return best;
}

/**
 * Attribute a tick's swing to the player who caused it: whoever gained the most
 * points between the two snapshots. This is why odds_snapshots.detail carries
 * per-player points — reconstructing it from stats history afterwards would
 * require storing every intermediate stat line, which we do not.
 */
function attributeSwing(
  previous: OddsSnapshot,
  current: OddsSnapshot,
): { playerId: string | null; points: number } {
  const before = previous.detail?.playerPoints;
  const after = current.detail?.playerPoints;
  if (!before || !after) return { playerId: null, points: 0 };

  let bestId: string | null = null;
  let bestGain = 0;

  for (const [playerId, points] of Object.entries(after)) {
    const gain = points - (before[playerId] ?? 0);
    if (gain > bestGain) {
      bestGain = gain;
      bestId = playerId;
    }
  }

  return { playerId: bestId, points: round2(bestGain) };
}

/**
 * Clinch time: the first tick after which the winner's probability never drops
 * back below the threshold. Scanning backwards is what makes it "never again in
 * doubt" rather than "first time it crossed", which a late swing would falsify.
 */
function findClinch(ticks: OddsSnapshot[], winner: 'a' | 'b' | 'tie'): string | null {
  if (winner === 'tie' || ticks.length === 0) return null;

  const probFor = (tick: OddsSnapshot) => (winner === 'a' ? tick.winProbA : 1 - tick.winProbA);

  const last = ticks[ticks.length - 1] as OddsSnapshot;
  if (probFor(last) < CLINCH_THRESHOLD) return null;

  let clinch = last.capturedAt;
  for (let i = ticks.length - 1; i >= 0; i -= 1) {
    const tick = ticks[i] as OddsSnapshot;
    if (probFor(tick) < CLINCH_THRESHOLD) break;
    clinch = tick.capturedAt;
  }
  return clinch;
}

function isClosingUpset(opening: OddsSnapshot, winner: 'a' | 'b' | 'tie'): boolean {
  if (winner === 'tie') return false;
  const favouredA = opening.winProbA > 0.5;
  if (Math.abs(opening.winProbA - 0.5) < 0.02) return false; // a coin flip is not an upset
  return favouredA ? winner === 'b' : winner === 'a';
}

/** Downsample a curve for charting without losing the inflection points. */
export function curveForChart(
  snapshots: OddsSnapshot[],
  maxPoints = 180,
): { at: string; winProbA: number; scoreA: number; scoreB: number }[] {
  const ticks = [...snapshots].sort(
    (x, y) => new Date(x.capturedAt).getTime() - new Date(y.capturedAt).getTime(),
  );
  if (ticks.length <= maxPoints) return ticks.map(toPoint);

  // Keep the extremes and the endpoints, then fill in evenly. Uniform sampling
  // alone would smooth away the very spikes the chart exists to show.
  const keep = new Set<number>([0, ticks.length - 1]);
  let maxIdx = 0;
  let minIdx = 0;
  for (let i = 0; i < ticks.length; i += 1) {
    if ((ticks[i] as OddsSnapshot).winProbA > (ticks[maxIdx] as OddsSnapshot).winProbA) maxIdx = i;
    if ((ticks[i] as OddsSnapshot).winProbA < (ticks[minIdx] as OddsSnapshot).winProbA) minIdx = i;
  }
  keep.add(maxIdx);
  keep.add(minIdx);

  const stride = ticks.length / (maxPoints - keep.size);
  for (let i = 0; i < ticks.length; i += stride) keep.add(Math.floor(i));

  return [...keep]
    .sort((a, b) => a - b)
    .map((i) => toPoint(ticks[i] as OddsSnapshot));
}

function toPoint(tick: OddsSnapshot) {
  return {
    at: tick.capturedAt,
    winProbA: tick.winProbA,
    scoreA: tick.detail?.scoreA ?? 0,
    scoreB: tick.detail?.scoreB ?? 0,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
