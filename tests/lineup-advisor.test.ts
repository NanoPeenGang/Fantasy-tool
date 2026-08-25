import { describe, expect, it } from 'vitest';
import { adviseLineup, type LineupPlayer } from '@/lib/lineup/advisor';

const ROSTER_POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN'];

function player(
  id: string,
  position: string,
  projection: number,
  started: boolean,
  over: Partial<LineupPlayer> = {},
): LineupPlayer {
  return {
    id, name: id, position, team: 'BUF', injuryStatus: null,
    projection, started, byeWeek: null, ...over,
  };
}

/** A lineup with an obvious mistake: the best receiver is on the bench. */
function rosterWithBenchedStud(): LineupPlayer[] {
  return [
    player('qb', 'QB', 20, true),
    player('rb1', 'RB', 15, true),
    player('rb2', 'RB', 12, true),
    player('wr1', 'WR', 14, true),
    player('wr2', 'WR', 5, true),
    player('te', 'TE', 9, true),
    player('flex', 'RB', 8, true),
    player('stud', 'WR', 22, false),
  ];
}

function opponent(total: number[]): LineupPlayer[] {
  return total.map((projection, i) => player(`o${i}`, 'WR', projection, true, { team: `T${i}` }));
}

describe('adviseLineup', () => {
  it('projects the current lineup and the optimal one', () => {
    const advice = adviseLineup({
      week: 5, roster: rosterWithBenchedStud(), rosterPositions: ROSTER_POSITIONS,
    });
    expect(advice.currentProjected).toBe(83);
    // The stud (22) replaces wr2 (5).
    expect(advice.optimalProjected).toBe(100);
    expect(advice.pointsLeftOnBench).toBe(17);
  });

  it('names the swap that gains the most', () => {
    const advice = adviseLineup({
      week: 5, roster: rosterWithBenchedStud(), rosterPositions: ROSTER_POSITIONS,
    });
    const top = advice.calls[0];
    expect(top?.startPlayer.id).toBe('stud');
    expect(top?.sitPlayer?.id).toBe('wr2');
    expect(top?.pointsAdded).toBe(17);
  });

  it('has nothing to say about an already optimal lineup', () => {
    const roster = rosterWithBenchedStud().map((p) =>
      p.id === 'stud' ? { ...p, started: true } : p.id === 'wr2' ? { ...p, started: false } : p,
    );
    const advice = adviseLineup({ week: 5, roster, rosterPositions: ROSTER_POSITIONS });
    expect(advice.calls).toEqual([]);
    expect(advice.pointsLeftOnBench).toBe(0);
  });

  describe('with an opponent', () => {
    it('prices every call in win probability, not points', () => {
      const advice = adviseLineup({
        week: 5,
        roster: rosterWithBenchedStud(),
        rosterPositions: ROSTER_POSITIONS,
        opponent: opponent([15, 14, 13, 12, 11, 10, 9]),
      });

      const top = advice.calls[0];
      expect(top?.winProbabilityAdded).not.toBeNull();
      expect(top?.winProbabilityAdded as number).toBeGreaterThan(0);
      expect(top?.reason).toContain('% to win');
    });

    it('reports the win probability of both lineups', () => {
      const advice = adviseLineup({
        week: 5,
        roster: rosterWithBenchedStud(),
        rosterPositions: ROSTER_POSITIONS,
        opponent: opponent([15, 14, 13, 12, 11, 10, 9]),
      });
      expect(advice.currentWinProbability).not.toBeNull();
      expect(advice.optimalWinProbability as number).toBeGreaterThan(
        advice.currentWinProbability as number,
      );
    });

    /**
     * The reason win probability is the right unit: the same points are worth
     * far more in a close matchup than in one already decided.
     */
    it('values the same swap more in a close matchup than a blowout', () => {
      const roster = rosterWithBenchedStud();
      const close = adviseLineup({
        week: 5, roster, rosterPositions: ROSTER_POSITIONS,
        opponent: opponent([14, 13, 13, 12, 12, 11, 10]),
      });
      const hopeless = adviseLineup({
        week: 5, roster, rosterPositions: ROSTER_POSITIONS,
        opponent: opponent([40, 38, 36, 34, 32, 30, 28]),
      });

      expect(close.calls[0]?.pointsAdded).toBe(hopeless.calls[0]?.pointsAdded);
      expect(close.calls[0]?.winProbabilityAdded as number).toBeGreaterThan(
        hopeless.calls[0]?.winProbabilityAdded as number,
      );
    });
  });

  it('falls back to points when no opponent is known', () => {
    const advice = adviseLineup({
      week: 5, roster: rosterWithBenchedStud(), rosterPositions: ROSTER_POSITIONS,
    });
    expect(advice.currentWinProbability).toBeNull();
    expect(advice.calls[0]?.winProbabilityAdded).toBeNull();
    expect(advice.calls[0]?.reason).toContain('projected points');
  });

  describe('flags', () => {
    it('catches a starter on bye', () => {
      const roster = rosterWithBenchedStud().map((p) =>
        p.id === 'wr1' ? { ...p, byeWeek: 5 } : p,
      );
      const advice = adviseLineup({ week: 5, roster, rosterPositions: ROSTER_POSITIONS });
      expect(advice.flags.some((f) => f.kind === 'bye' && f.player === 'wr1')).toBe(true);
    });

    it('does not flag a bye in a different week', () => {
      const roster = rosterWithBenchedStud().map((p) =>
        p.id === 'wr1' ? { ...p, byeWeek: 9 } : p,
      );
      const advice = adviseLineup({ week: 5, roster, rosterPositions: ROSTER_POSITIONS });
      expect(advice.flags.some((f) => f.kind === 'bye')).toBe(false);
    });

    it('catches a starter already ruled out', () => {
      const roster = rosterWithBenchedStud().map((p) =>
        p.id === 'rb1' ? { ...p, injuryStatus: 'Out' } : p,
      );
      const advice = adviseLineup({ week: 5, roster, rosterPositions: ROSTER_POSITIONS });
      expect(advice.flags.some((f) => f.kind === 'injury' && f.player === 'rb1')).toBe(true);
    });

    it('catches an empty starting slot', () => {
      const roster = rosterWithBenchedStud().filter((p) => p.id !== 'te');
      const advice = adviseLineup({ week: 5, roster, rosterPositions: ROSTER_POSITIONS });
      expect(advice.flags.some((f) => f.kind === 'empty_slot')).toBe(true);
    });

    it('stays quiet on a healthy full lineup', () => {
      const advice = adviseLineup({
        week: 5, roster: rosterWithBenchedStud(), rosterPositions: ROSTER_POSITIONS,
      });
      expect(advice.flags).toEqual([]);
    });
  });

  it('returns the optimal lineup slot by slot', () => {
    const advice = adviseLineup({
      week: 5, roster: rosterWithBenchedStud(), rosterPositions: ROSTER_POSITIONS,
    });
    expect(advice.optimalLineup).toHaveLength(7);
    expect(advice.optimalLineup.find((s) => s.slot === 'QB')?.player?.id).toBe('qb');
    const startedIds = advice.optimalLineup.map((s) => s.player?.id);
    expect(startedIds).toContain('stud');
    expect(startedIds).not.toContain('wr2');
  });

  it('is deterministic across runs', () => {
    const run = () =>
      adviseLineup({
        week: 5, roster: rosterWithBenchedStud(), rosterPositions: ROSTER_POSITIONS,
        opponent: opponent([15, 14, 13, 12, 11, 10, 9]),
      });
    expect(run().calls[0]?.winProbabilityAdded).toBe(run().calls[0]?.winProbabilityAdded);
  });
});
