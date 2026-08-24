import { describe, expect, it } from 'vitest';
import {
  coachingReport,
  hungarian,
  scoringSlots,
  slotAccepts,
  solveOptimalLineup,
} from '@/lib/compute/lineup';
import type { PlayerRef } from '@/lib/compute/types';

function player(id: string, position: string, name = id): PlayerRef {
  return { id, name, position, team: 'BUF', injuryStatus: null };
}

const STANDARD = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN', 'IR'];

describe('slot eligibility', () => {
  it('accepts exact position matches', () => {
    expect(slotAccepts('QB', 'QB')).toBe(true);
    expect(slotAccepts('QB', 'RB')).toBe(false);
  });

  it('handles the flex family', () => {
    expect(slotAccepts('FLEX', 'RB')).toBe(true);
    expect(slotAccepts('FLEX', 'QB')).toBe(false);
    expect(slotAccepts('SUPER_FLEX', 'QB')).toBe(true);
    expect(slotAccepts('REC_FLEX', 'RB')).toBe(false);
    expect(slotAccepts('REC_FLEX', 'TE')).toBe(true);
  });

  it('drops bench and reserve slots', () => {
    expect(scoringSlots(STANDARD)).toEqual(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF']);
  });
});

describe('solveOptimalLineup', () => {
  /**
   * The case greedy sorting gets wrong: filling FLEX with the best remaining
   * flex-eligible player strands a required WR slot. Here the roster has three
   * WRs and one RB; greedy puts WR3 in FLEX and leaves nothing for... actually
   * it strands the RB, which is worth more than WR3.
   */
  it('does not burn the flex on a player a mandatory slot needs', () => {
    const roster = [
      player('wr1', 'WR'), player('wr2', 'WR'), player('wr3', 'WR'),
      player('rb1', 'RB'),
    ];
    const weights = { wr1: 25, wr2: 20, wr3: 18, rb1: 12 };

    const result = solveOptimalLineup({
      players: roster,
      weights,
      rosterPositions: ['WR', 'WR', 'FLEX'],
    });

    // WR1 + WR2 in the WR slots, then the FLEX takes WR3 (18) over RB1 (12).
    expect(result.total).toBe(63);
    expect(new Set(result.startedIds)).toEqual(new Set(['wr1', 'wr2', 'wr3']));
  });

  it('prefers the globally optimal assignment over the locally greedy one', () => {
    // Greedy on FLEX first takes RB1 (20), leaving RB2 (5) for the RB slot: 25.
    // Optimal puts RB1 in RB and WR1 in FLEX: 20 + 15 = 35.
    const roster = [player('rb1', 'RB'), player('rb2', 'RB'), player('wr1', 'WR')];
    const weights = { rb1: 20, rb2: 5, wr1: 15 };

    const result = solveOptimalLineup({
      players: roster,
      weights,
      rosterPositions: ['RB', 'FLEX'],
    });

    expect(result.total).toBe(35);
    expect(new Set(result.startedIds)).toEqual(new Set(['rb1', 'wr1']));
  });

  it('leaves a slot empty when nothing is eligible', () => {
    const result = solveOptimalLineup({
      players: [player('wr1', 'WR')],
      weights: { wr1: 10 },
      rosterPositions: ['WR', 'QB'],
    });

    expect(result.total).toBe(10);
    const qbSlot = result.slots.find((s) => s.slot === 'QB');
    expect(qbSlot?.player).toBeNull();
  });

  it('never starts an ineligible player even when the roster is thin', () => {
    const result = solveOptimalLineup({
      players: [player('k1', 'K')],
      weights: { k1: 30 },
      rosterPositions: ['QB', 'RB'],
    });
    expect(result.total).toBe(0);
    expect(result.startedIds).toEqual([]);
  });

  it('handles superflex, which changes which QB sits', () => {
    const roster = [player('qb1', 'QB'), player('qb2', 'QB'), player('rb1', 'RB')];
    const weights = { qb1: 28, qb2: 22, rb1: 14 };

    const superflex = solveOptimalLineup({
      players: roster, weights, rosterPositions: ['QB', 'SUPER_FLEX'],
    });
    expect(superflex.total).toBe(50);

    const standardFlex = solveOptimalLineup({
      players: roster, weights, rosterPositions: ['QB', 'FLEX'],
    });
    expect(standardFlex.total).toBe(42);
  });
});

describe('coachingReport', () => {
  const roster = [
    player('qb1', 'QB'), player('rb1', 'RB'), player('rb2', 'RB'),
    player('wr1', 'WR'), player('wr2', 'WR'), player('te1', 'TE'),
    player('benchwr', 'WR'),
  ];
  const points = {
    qb1: 22, rb1: 15, rb2: 8, wr1: 18, wr2: 6, te1: 9, benchwr: 27,
  };
  const positions = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'BN'];

  it('measures efficiency against the optimal lineup', () => {
    const report = coachingReport({
      roster,
      started: ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'te1'],
      points,
      rosterPositions: positions,
    });

    expect(report.actual).toBe(78);
    // benchwr (27) replaces wr2 (6) in a WR slot.
    expect(report.optimal).toBe(99);
    expect(report.benchPointsLeft).toBe(21);
    expect(report.efficiency).toBeCloseTo(78 / 99, 4);
  });

  it('names the swap that would have been made', () => {
    const report = coachingReport({
      roster,
      started: ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'te1'],
      points,
      rosterPositions: positions,
    });

    const worst = report.regrets[0];
    expect(worst?.benchPlayer.id).toBe('benchwr');
    expect(worst?.replacing?.id).toBe('wr2');
    expect(worst?.delta).toBe(21);
  });

  it('reports a perfect lineup as fully efficient with no regrets', () => {
    const report = coachingReport({
      roster,
      started: ['qb1', 'rb1', 'rb2', 'wr1', 'benchwr', 'te1'],
      points,
      rosterPositions: positions,
    });

    expect(report.efficiency).toBe(1);
    expect(report.benchPointsLeft).toBe(0);
    expect(report.regrets).toEqual([]);
  });

  it('does not count bench points that had nowhere legal to go', () => {
    // A 40-point bench QB in a one-QB league where the started QB scored more.
    const withBackupQb = [...roster, player('qb2', 'QB')];
    const report = coachingReport({
      roster: withBackupQb,
      started: ['qb1', 'rb1', 'rb2', 'wr1', 'benchwr', 'te1'],
      points: { ...points, qb2: 21 },
      rosterPositions: positions,
    });

    expect(report.benchPointsLeft).toBe(0);
  });
});

describe('hungarian', () => {
  it('finds the minimum-cost assignment', () => {
    const cost = [
      [4, 1, 3],
      [2, 0, 5],
      [3, 2, 2],
    ];
    const assignment = hungarian(cost);
    const total = assignment.reduce((sum, col, row) => sum + (cost[row] as number[])[col]!, 0);
    expect(total).toBe(5);
  });

  it('handles rectangular matrices with more columns than rows', () => {
    const cost = [
      [1, 9, 9, 9],
      [9, 9, 2, 9],
    ];
    const assignment = hungarian(cost);
    expect(assignment).toEqual([0, 2]);
  });

  it('rejects matrices with fewer columns than rows', () => {
    expect(() => hungarian([[1, 2], [3, 4], [5, 6]])).toThrow(/columns/);
  });
});
