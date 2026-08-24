import { describe, expect, it } from 'vitest';
import { curveForChart, swingMetrics } from '@/lib/compute/swing';
import type { OddsSnapshot } from '@/lib/compute/types';

function tick(
  minutes: number,
  winProbA: number,
  playerPoints: Record<string, number> = {},
): OddsSnapshot {
  return {
    capturedAt: new Date(Date.UTC(2026, 9, 18, 17, minutes)).toISOString(),
    phase: 'live',
    winProbA,
    spread: 0,
    total: 220,
    moneylineA: -110,
    moneylineB: -110,
    meanA: 110,
    meanB: 110,
    sdA: 20,
    sdB: 20,
    detail: { scoreA: 0, scoreB: 0, playerPoints },
  };
}

describe('swingMetrics', () => {
  it('returns empty metrics when no snapshots were persisted', () => {
    const metrics = swingMetrics([], 'a');
    expect(metrics.peakA).toBeNull();
    expect(metrics.comebackIndex).toBeNull();
    expect(metrics.clinchAt).toBeNull();
  });

  it('finds each side peak win probability', () => {
    const metrics = swingMetrics([tick(0, 0.5), tick(10, 0.94), tick(20, 0.2)], 'b');
    expect(metrics.peakA?.value).toBe(0.94);
    expect(metrics.peakB?.value).toBeCloseTo(0.8, 6);
  });

  /** "Led 94% at 4:12 and lost" is the single best line the product produces. */
  it('records a heist: the winner low-water mark', () => {
    const metrics = swingMetrics([tick(0, 0.5), tick(10, 0.94), tick(20, 0.4), tick(30, 0)], 'b');
    // B's minimum was 1 - 0.94 = 0.06.
    expect(metrics.comebackIndex).toBeCloseTo(0.06, 6);
  });

  it('flags dead on arrival when the loser never cleared 25%', () => {
    // A led all day and B never got above 22%: B was never alive.
    const doa = swingMetrics([tick(0, 0.8), tick(10, 0.78), tick(20, 1)], 'a');
    expect(doa.deadOnArrival).toBe(true);

    // B got to 45% at one point, so the game was a game.
    const contested = swingMetrics([tick(0, 0.8), tick(10, 0.55), tick(20, 1)], 'a');
    expect(contested.deadOnArrival).toBe(false);
  });

  it('attributes the biggest swing to the player who scored through it', () => {
    const metrics = swingMetrics(
      [
        tick(0, 0.5, { kelce: 0, allen: 0 }),
        tick(10, 0.55, { kelce: 2, allen: 3 }),
        tick(20, 0.88, { kelce: 20, allen: 5 }),
      ],
      'a',
    );

    expect(metrics.biggestSwing?.playerId).toBe('kelce');
    expect(metrics.biggestSwing?.delta).toBeCloseTo(0.33, 6);
    expect(metrics.biggestSwing?.towardA).toBe(true);
    expect(metrics.biggestSwing?.playerPoints).toBe(18);
  });

  it('leaves attribution null when no per-player detail was captured', () => {
    const bare = [tick(0, 0.5), tick(10, 0.9)].map((t) => ({ ...t, detail: undefined }));
    const metrics = swingMetrics(bare, 'a');
    expect(metrics.biggestSwing?.playerId).toBeNull();
    expect(metrics.biggestSwing?.delta).toBeCloseTo(0.4, 6);
  });

  /**
   * Clinch is "never in doubt again", not "first crossed" — a late swing back
   * below the threshold has to push the clinch later.
   */
  it('finds the last time the outcome stopped being in doubt', () => {
    const metrics = swingMetrics(
      [tick(0, 0.5), tick(10, 0.995), tick(20, 0.6), tick(30, 0.999), tick(40, 1)],
      'a',
    );
    expect(metrics.clinchAt).toBe(tick(30, 0).capturedAt);
  });

  it('reports no clinch when the final tick was still live', () => {
    const metrics = swingMetrics([tick(0, 0.5), tick(10, 0.7)], 'a');
    expect(metrics.clinchAt).toBeNull();
  });

  it('detects a closing upset against the opening line', () => {
    const upset = swingMetrics([tick(0, 0.8), tick(10, 0.1), tick(20, 0)], 'b');
    expect(upset.closingUpset).toBe(true);

    const chalk = swingMetrics([tick(0, 0.8), tick(10, 0.9), tick(20, 1)], 'a');
    expect(chalk.closingUpset).toBe(false);
  });

  it('does not call a coin flip an upset', () => {
    const metrics = swingMetrics([tick(0, 0.505), tick(10, 0)], 'b');
    expect(metrics.closingUpset).toBe(false);
  });

  it('sorts snapshots that arrive out of order', () => {
    const metrics = swingMetrics([tick(20, 1), tick(0, 0.3), tick(10, 0.6)], 'a');
    expect(metrics.opening?.winProbA).toBe(0.3);
    expect(metrics.final?.winProbA).toBe(1);
  });

  it('has no comeback story for a tie', () => {
    const metrics = swingMetrics([tick(0, 0.5), tick(10, 0.5)], 'tie');
    expect(metrics.comebackIndex).toBeNull();
    expect(metrics.closingUpset).toBe(false);
    expect(metrics.deadOnArrival).toBe(false);
  });
});

describe('curveForChart', () => {
  it('passes short curves through untouched', () => {
    const ticks = [tick(0, 0.5), tick(10, 0.6)];
    expect(curveForChart(ticks, 180)).toHaveLength(2);
  });

  it('downsamples without dropping the extremes', () => {
    const ticks = Array.from({ length: 500 }, (_, i) => tick(i, 0.5));
    ticks[123] = tick(123, 0.99);
    ticks[400] = tick(400, 0.01);

    const curve = curveForChart(ticks, 50);
    expect(curve.length).toBeLessThanOrEqual(55);
    expect(curve.some((p) => p.winProbA === 0.99)).toBe(true);
    expect(curve.some((p) => p.winProbA === 0.01)).toBe(true);
  });

  it('keeps the endpoints', () => {
    const ticks = Array.from({ length: 300 }, (_, i) => tick(i, i / 300));
    const curve = curveForChart(ticks, 40);
    expect(curve[0]?.at).toBe(ticks[0]?.capturedAt);
    expect(curve[curve.length - 1]?.at).toBe(ticks[299]?.capturedAt);
  });
});
