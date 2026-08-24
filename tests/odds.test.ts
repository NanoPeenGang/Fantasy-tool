import { describe, expect, it } from 'vitest';
import {
  contributionFor,
  formatAmerican,
  formatSpread,
  inactiveProbability,
  positionCv,
  probabilityToAmerican,
  simulateMatchup,
  winProbabilityAdded,
} from '@/lib/compute/odds';
import { pairCorrelation, cholesky, correlationMatrix } from '@/lib/compute/correlation';
import type { StarterState } from '@/lib/compute/types';

function starter(overrides: Partial<StarterState> & { id: string; position: string }): StarterState {
  return {
    name: overrides.id,
    team: 'BUF',
    injuryStatus: null,
    projection: 12,
    actual: 0,
    gameStatus: 'pre',
    gamePctElapsed: 0,
    ...overrides,
  } as StarterState;
}

function lineup(prefix: string, projections: number[], position = 'WR'): StarterState[] {
  return projections.map((projection, i) =>
    starter({ id: `${prefix}${i}`, position, projection, team: `T${i}` }),
  );
}

describe('probabilityToAmerican', () => {
  it('matches the spec formulas', () => {
    expect(probabilityToAmerican(0.5)).toBe(-100);
    expect(probabilityToAmerican(0.75)).toBe(-300);
    expect(probabilityToAmerican(0.25)).toBe(300);
    expect(probabilityToAmerican(0.6)).toBe(-150);
  });

  it('never returns a non-finite line at the extremes', () => {
    expect(Number.isFinite(probabilityToAmerican(0))).toBe(true);
    expect(Number.isFinite(probabilityToAmerican(1))).toBe(true);
  });

  it('formats with an explicit sign', () => {
    expect(formatAmerican(150)).toBe('+150');
    expect(formatAmerican(-150)).toBe('-150');
  });
});

describe('formatSpread', () => {
  it('puts the negative number on the favourite', () => {
    expect(formatSpread(6.5, 'Dave', 'Kim')).toBe('Dave -6.5');
    expect(formatSpread(-6.5, 'Dave', 'Kim')).toBe('Kim -6.5');
    expect(formatSpread(0, 'Dave', 'Kim')).toBe('PK');
  });
});

describe('injury zero-inflation', () => {
  it('maps designations to inactive probabilities', () => {
    expect(inactiveProbability('Out')).toBe(1);
    expect(inactiveProbability('Questionable')).toBe(0.25);
    expect(inactiveProbability(null)).toBe(0);
    expect(inactiveProbability('Some Unknown Tag')).toBe(0);
  });

  it('lowers a questionable player win probability without zeroing them out', () => {
    const healthy = lineup('a', [20, 20, 20]);
    const opponent = lineup('b', [20, 20, 20]);

    const questionable = healthy.map((s, i) =>
      i === 0 ? { ...s, injuryStatus: 'Questionable' } : s,
    );

    const base = simulateMatchup(healthy, opponent, { seed: 7, iterations: 20_000 });
    const injured = simulateMatchup(questionable, opponent, { seed: 7, iterations: 20_000 });

    expect(injured.winProbA).toBeLessThan(base.winProbA);
    expect(injured.winProbA).toBeGreaterThan(0.15);
  });
});

describe('positionCv', () => {
  it('uses the positional prior and prefers a fitted value when supplied', () => {
    expect(positionCv('QB')).toBe(0.35);
    expect(positionCv('DEF')).toBe(0.75);
    expect(positionCv('QB', 0.28)).toBe(0.28);
    expect(positionCv('QB', null)).toBe(0.35);
    expect(positionCv('LONGSNAPPER')).toBe(0.6);
  });
});

describe('contributionFor', () => {
  it('banks a final score with no remaining uncertainty', () => {
    const contribution = contributionFor(
      starter({ id: 'x', position: 'RB', gameStatus: 'final', actual: 21.4 }),
    );
    expect(contribution.banked).toBe(21.4);
    expect(contribution.table).toBeNull();
  });

  it('samples the full distribution before kickoff', () => {
    const contribution = contributionFor(starter({ id: 'x', position: 'RB', projection: 14 }));
    expect(contribution.banked).toBe(0);
    expect(contribution.table?.mean()).toBeCloseTo(14, 6);
  });

  it('splits a live player into banked points plus a shrunken remainder', () => {
    const contribution = contributionFor(
      starter({
        id: 'x', position: 'WR', projection: 16,
        gameStatus: 'live', gamePctElapsed: 0.75, actual: 9,
      }),
    );
    expect(contribution.banked).toBe(9);
    expect(contribution.table?.mean()).toBeCloseTo(4, 6);
  });

  it('shrinks variance by sqrt of remaining share, not linearly', () => {
    // With a quarter of the game left, a player keeps half their CV, not a
    // quarter of it — garbage-time touchdowns are real.
    const quarterLeft = contributionFor(
      starter({
        id: 'x', position: 'WR', projection: 16,
        gameStatus: 'live', gamePctElapsed: 0.75, actual: 0,
      }),
    );
    const table = quarterLeft.table!;
    const cvRemaining = table.sd() / table.mean();
    expect(cvRemaining).toBeCloseTo(0.65 * Math.sqrt(0.25), 4);
  });

  it('treats a fully elapsed live game as final', () => {
    const contribution = contributionFor(
      starter({
        id: 'x', position: 'WR', gameStatus: 'live', gamePctElapsed: 1, actual: 12,
      }),
    );
    expect(contribution.table).toBeNull();
    expect(contribution.banked).toBe(12);
  });
});

describe('simulateMatchup', () => {
  it('prices identical lineups as a coin flip', () => {
    const result = simulateMatchup(lineup('a', [15, 12, 9]), lineup('b', [15, 12, 9]), {
      seed: 42, iterations: 20_000,
    });
    expect(result.winProbA).toBeGreaterThan(0.47);
    expect(result.winProbA).toBeLessThan(0.53);
    expect(Math.abs(result.spread)).toBeLessThan(1.5);
  });

  it('favours the higher-projected side', () => {
    const result = simulateMatchup(lineup('a', [24, 20, 18]), lineup('b', [10, 9, 8]), {
      seed: 1, iterations: 10_000,
    });
    expect(result.winProbA).toBeGreaterThan(0.9);
    expect(result.moneylineA).toBeLessThan(-300);
    expect(result.moneylineB).toBeGreaterThan(300);
  });

  it('is deterministic for a given seed', () => {
    const a = simulateMatchup(lineup('a', [15, 12]), lineup('b', [14, 13]), { seed: 99 });
    const b = simulateMatchup(lineup('a', [15, 12]), lineup('b', [14, 13]), { seed: 99 });
    expect(a.winProbA).toBe(b.winProbA);
    expect(a.spread).toBe(b.spread);
  });

  it('snaps to a certainty when every player is final', () => {
    const done = (id: string, actual: number) =>
      starter({ id, position: 'WR', gameStatus: 'final', actual });

    const result = simulateMatchup([done('a', 60)], [done('b', 50)], { iterations: 500 });
    expect(result.winProbA).toBe(1);
    expect(result.sdA).toBe(0);
    expect(result.spread).toBe(10);
  });

  it('recovers a plausible team total', () => {
    const projections = [22, 16, 14, 13, 11, 9, 8, 7, 6];
    const result = simulateMatchup(lineup('a', projections), lineup('b', projections), {
      seed: 5, iterations: 20_000,
    });
    const expectedTotal = projections.reduce((s, p) => s + p, 0);
    expect(result.meanA).toBeGreaterThan(expectedTotal * 0.97);
    expect(result.meanA).toBeLessThan(expectedTotal * 1.03);
  });

  it('keeps the median total near the sum of both projections', () => {
    const result = simulateMatchup(lineup('a', [20, 20]), lineup('b', [20, 20]), {
      seed: 3, iterations: 20_000,
    });
    expect(result.total).toBeGreaterThan(70);
    expect(result.total).toBeLessThan(82);
  });
});

describe('correlation', () => {
  it('scores the tiers from the spec', () => {
    const qb = starter({ id: 'qb', position: 'QB', team: 'BUF', opponentTeam: 'MIA' });
    const wr = starter({ id: 'wr', position: 'WR', team: 'BUF', opponentTeam: 'MIA' });
    const rb = starter({ id: 'rb', position: 'RB', team: 'BUF', opponentTeam: 'MIA' });
    const oppWr = starter({ id: 'owr', position: 'WR', team: 'MIA', opponentTeam: 'BUF' });
    const unrelated = starter({ id: 'x', position: 'WR', team: 'KC', opponentTeam: 'DEN' });

    expect(pairCorrelation(qb, wr)).toBeCloseTo(0.45, 6);
    expect(pairCorrelation(qb, rb)).toBeCloseTo(0.1, 6);
    expect(pairCorrelation(wr, oppWr)).toBeCloseTo(0.15, 6);
    expect(pairCorrelation(qb, unrelated)).toBe(0);
  });

  it('is symmetric and unit-diagonal', () => {
    const starters = [
      starter({ id: 'qb', position: 'QB', team: 'BUF', opponentTeam: 'MIA' }),
      starter({ id: 'wr', position: 'WR', team: 'BUF', opponentTeam: 'MIA' }),
      starter({ id: 'te', position: 'TE', team: 'MIA', opponentTeam: 'BUF' }),
    ];
    const matrix = correlationMatrix(starters);
    for (let i = 0; i < matrix.length; i += 1) {
      expect(matrix[i]![i]).toBe(1);
      for (let j = 0; j < matrix.length; j += 1) {
        expect(matrix[i]![j]).toBe(matrix[j]![i]);
      }
    }
  });

  it('factorises even when the pairwise priors are not positive definite', () => {
    // Hand-built inconsistent matrix: A and B both strongly positive with C,
    // but strongly negative with each other.
    const bad = [
      [1, 0.95, 0.95],
      [0.95, 1, -0.95],
      [0.95, -0.95, 1],
    ];
    const L = cholesky(bad);
    expect(L.length).toBe(3);
    expect(L.every((row) => row.every((v) => Number.isFinite(v)))).toBe(true);
  });

  /**
   * The claim the spec makes about correlation: stacking a QB with his own WR
   * widens the team's outcome distribution, which changes upset probability.
   */
  it('widens the score distribution for a stacked lineup', () => {
    const stacked: StarterState[] = [
      starter({ id: 'qb', position: 'QB', team: 'BUF', opponentTeam: 'MIA', projection: 20 }),
      starter({ id: 'wr', position: 'WR', team: 'BUF', opponentTeam: 'MIA', projection: 15 }),
      starter({ id: 'te', position: 'TE', team: 'BUF', opponentTeam: 'MIA', projection: 10 }),
    ];
    const opponent = lineup('b', [20, 15, 10]);

    const correlated = simulateMatchup(stacked, opponent, {
      seed: 11, iterations: 30_000, correlate: true,
    });
    const independent = simulateMatchup(stacked, opponent, {
      seed: 11, iterations: 30_000, correlate: false,
    });

    expect(correlated.sdA).toBeGreaterThan(independent.sdA);
  });

  /**
   * The consequence of that widening, and the reason it is worth the cost: a
   * stacked underdog needs ceiling, so pricing them independently understates
   * how often they win. The effect is small in absolute terms (~0.8pp here) and
   * grows with the deficit, so the assertion uses a lineup far enough behind for
   * the effect to clear Monte Carlo noise. Measured across five seeds it lands
   * between 0.0073 and 0.0094.
   */
  it('makes a stacked underdog live more often than independence implies', () => {
    const underdog: StarterState[] = [
      starter({ id: 'qb', position: 'QB', team: 'BUF', opponentTeam: 'MIA', projection: 18 }),
      starter({ id: 'wr', position: 'WR', team: 'BUF', opponentTeam: 'MIA', projection: 14 }),
      starter({ id: 'te', position: 'TE', team: 'BUF', opponentTeam: 'MIA', projection: 10 }),
    ];
    const favourite = [
      starter({ id: 'f1', position: 'RB', team: 'KC', opponentTeam: 'DEN', projection: 19 }),
      starter({ id: 'f2', position: 'RB', team: 'SF', opponentTeam: 'SEA', projection: 19 }),
      starter({ id: 'f3', position: 'WR', team: 'NYJ', opponentTeam: 'NE', projection: 20 }),
    ];

    const correlated = simulateMatchup(underdog, favourite, {
      seed: 21, iterations: 100_000, correlate: true,
    });
    const independent = simulateMatchup(underdog, favourite, {
      seed: 21, iterations: 100_000, correlate: false,
    });

    expect(correlated.winProbA - independent.winProbA).toBeGreaterThan(0.004);
  });

  /**
   * The mirror image, and the part that matters for a commissioner's trust: at a
   * coin flip, extra variance does not help the underdog, so correlation must
   * not systematically inflate every long shot. Independence is wrong in both
   * directions and the engine has to get the sign right in each.
   */
  it('does not help a stacked lineup that is already even money', () => {
    const stacked: StarterState[] = [
      starter({ id: 'qb', position: 'QB', team: 'BUF', opponentTeam: 'MIA', projection: 18 }),
      starter({ id: 'wr', position: 'WR', team: 'BUF', opponentTeam: 'MIA', projection: 14 }),
      starter({ id: 'te', position: 'TE', team: 'BUF', opponentTeam: 'MIA', projection: 10 }),
    ];
    const even = [
      starter({ id: 'f1', position: 'RB', team: 'KC', opponentTeam: 'DEN', projection: 14 }),
      starter({ id: 'f2', position: 'RB', team: 'SF', opponentTeam: 'SEA', projection: 14 }),
      starter({ id: 'f3', position: 'WR', team: 'NYJ', opponentTeam: 'NE', projection: 14 }),
    ];

    const correlated = simulateMatchup(stacked, even, {
      seed: 21, iterations: 100_000, correlate: true,
    });
    const independent = simulateMatchup(stacked, even, {
      seed: 21, iterations: 100_000, correlate: false,
    });

    expect(correlated.winProbA).toBeLessThanOrEqual(independent.winProbA);
  });
});

describe('winProbabilityAdded', () => {
  it('prices a clear upgrade as positive win probability', () => {
    const starters = lineup('a', [10, 10, 10]);
    const opponent = lineup('b', [15, 15, 15]);
    const upgrade = starter({ id: 'stud', position: 'WR', projection: 28, team: 'T9' });

    const wpa = winProbabilityAdded({
      starters, opponent, swapOut: 'a0', swapIn: upgrade,
    });

    expect(wpa).toBeGreaterThan(0.05);
  });

  it('prices a downgrade as negative', () => {
    const starters = lineup('a', [20, 20, 20]);
    const opponent = lineup('b', [20, 20, 20]);
    const downgrade = starter({ id: 'scrub', position: 'WR', projection: 3, team: 'T9' });

    const wpa = winProbabilityAdded({
      starters, opponent, swapOut: 'a0', swapIn: downgrade,
    });

    expect(wpa).toBeLessThan(0);
  });

  it('reports roughly nothing for a lateral move', () => {
    const starters = lineup('a', [12, 12, 12]);
    const opponent = lineup('b', [12, 12, 12]);
    const lateral = starter({ id: 'same', position: 'WR', projection: 12, team: 'T0' });

    const wpa = winProbabilityAdded({ starters, opponent, swapOut: 'a0', swapIn: lateral });
    expect(Math.abs(wpa)).toBeLessThan(0.03);
  });
});
