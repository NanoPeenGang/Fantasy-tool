import { describe, expect, it } from 'vitest';
import {
  allPlayRecord,
  allPlayWinRate,
  headToHeadRecord,
  luckIndex,
  powerScores,
  recentMean,
  seasonMoments,
  type SeasonHistory,
} from '@/lib/compute/standings';

/**
 * A four-team, three-week league built so the luck story is unambiguous:
 * roster 1 scores worst every week but is scheduled against roster 4 (worse) and
 * wins; roster 2 scores best every week but keeps drawing roster 3.
 */
function history(): SeasonHistory {
  const weeks: SeasonHistory['weeks'] = [];
  const scores: Record<number, number[]> = {
    1: [100, 102, 98],
    2: [130, 128, 132],
    3: [120, 122, 118],
    4: [90, 92, 88],
  };
  // Schedule: 1v4 and 2v3 every week.
  const pairs: [number, number][] = [[1, 4], [2, 3]];

  for (let week = 1; week <= 3; week += 1) {
    for (const [a, b] of pairs) {
      const scoreA = (scores[a] as number[])[week - 1] as number;
      const scoreB = (scores[b] as number[])[week - 1] as number;
      weeks.push({ week, rosterId: a, score: scoreA, opponentRosterId: b, opponentScore: scoreB });
      weeks.push({ week, rosterId: b, score: scoreB, opponentRosterId: a, opponentScore: scoreA });
    }
  }
  return { weeks };
}

describe('allPlayRecord', () => {
  it('scores each team against every other team every week', () => {
    const h = history();
    // Roster 2 is highest every week: 3 wins per week over 3 opponents.
    expect(allPlayRecord(h, 2)).toEqual({ w: 9, l: 0, t: 0 });
    // Roster 4 is lowest every week.
    expect(allPlayRecord(h, 4)).toEqual({ w: 0, l: 9, t: 0 });
    // Roster 1 beats only roster 4.
    expect(allPlayRecord(h, 1)).toEqual({ w: 3, l: 6, t: 0 });
  });

  it('respects the through-week cutoff', () => {
    expect(allPlayRecord(history(), 2, 1)).toEqual({ w: 3, l: 0, t: 0 });
  });

  it('counts ties as halves in the win rate', () => {
    expect(allPlayWinRate({ w: 4, l: 4, t: 2 })).toBe(0.5);
    expect(allPlayWinRate({ w: 0, l: 0, t: 0 })).toBe(0);
  });
});

describe('headToHeadRecord', () => {
  it('follows the schedule as actually played', () => {
    const h = history();
    expect(headToHeadRecord(h, 1)).toMatchObject({ w: 3, l: 0, t: 0 });
    expect(headToHeadRecord(h, 3)).toMatchObject({ w: 0, l: 3, t: 0 });
  });

  it('accumulates points for and against', () => {
    const record = headToHeadRecord(history(), 1);
    expect(record.pf).toBe(300);
    expect(record.pa).toBe(270);
  });

  it('counts a bye week toward points for but not toward the record', () => {
    const h: SeasonHistory = {
      weeks: [{ week: 1, rosterId: 1, score: 110, opponentRosterId: null, opponentScore: null }],
    };
    const record = headToHeadRecord(h, 1);
    expect(record).toMatchObject({ w: 0, l: 0, t: 0, pf: 110, pa: 0 });
  });
});

describe('luckIndex', () => {
  it('is strongly positive for a bad team with a kind schedule', () => {
    // Roster 1 is 3-0 while winning only a third of its all-play games.
    expect(luckIndex(history(), 1)).toBe(2);
  });

  it('is strongly negative for a good team with a cruel schedule', () => {
    // Roster 3 is 0-3 despite winning two thirds of its all-play games.
    expect(luckIndex(history(), 3)).toBe(-2);
  });

  it('is zero for a team whose record matches its all-play expectation', () => {
    expect(luckIndex(history(), 2)).toBe(0);
    expect(luckIndex(history(), 4)).toBe(0);
  });

  it('sums to roughly zero across the league', () => {
    const h = history();
    const total = [1, 2, 3, 4].reduce((sum, id) => sum + luckIndex(h, id), 0);
    expect(Math.abs(total)).toBeLessThan(1e-9);
  });
});

describe('recentMean and seasonMoments', () => {
  it('averages the most recent weeks only', () => {
    const h: SeasonHistory = {
      weeks: [1, 2, 3, 4, 5].map((week) => ({
        week, rosterId: 1, score: week * 10, opponentRosterId: null, opponentScore: null,
      })),
    };
    expect(recentMean(h, 1, 5)).toBe(40); // weeks 3,4,5 -> 30,40,50
    expect(recentMean(h, 1, 3)).toBe(20); // weeks 1,2,3 -> 10,20,30
  });

  it('computes the sample standard deviation', () => {
    const h: SeasonHistory = {
      weeks: [100, 110, 120].map((score, i) => ({
        week: i + 1, rosterId: 1, score, opponentRosterId: null, opponentScore: null,
      })),
    };
    const moments = seasonMoments(h, 1);
    expect(moments.mean).toBe(110);
    expect(moments.sd).toBe(10);
  });

  it('reports zero deviation from a single week rather than NaN', () => {
    const h: SeasonHistory = {
      weeks: [{ week: 1, rosterId: 1, score: 100, opponentRosterId: null, opponentScore: null }],
    };
    expect(seasonMoments(h, 1)).toEqual({ mean: 100, sd: 0 });
  });
});

describe('powerScores', () => {
  const inputs = [
    { rosterId: 1, allPlayWinRate: 0.9, recentMean: 130, rosterStrength: 400, pointsFor: 390 },
    { rosterId: 2, allPlayWinRate: 0.5, recentMean: 110, rosterStrength: 350, pointsFor: 330 },
    { rosterId: 3, allPlayWinRate: 0.1, recentMean: 90, rosterStrength: 300, pointsFor: 270 },
  ];

  it('ranks the strongest team first', () => {
    const scored = powerScores(inputs);
    expect(scored.find((s) => s.rosterId === 1)?.powerRank).toBe(1);
    expect(scored.find((s) => s.rosterId === 3)?.powerRank).toBe(3);
  });

  it('produces distinct ranks for every team', () => {
    const ranks = powerScores(inputs).map((s) => s.powerRank).sort();
    expect(ranks).toEqual([1, 2, 3]);
  });

  /**
   * Without a projection source, roster strength is zero for everyone. Feeding
   * those zeros into the composite would shrink every score by 20% and compress
   * the spread; the weight is redistributed instead.
   */
  it('redistributes the roster-strength weight when no projections exist', () => {
    const withProjections = powerScores(inputs);
    const without = powerScores(inputs.map((i) => ({ ...i, rosterStrength: 0 })));

    const topWith = withProjections.find((s) => s.rosterId === 1)?.powerScore as number;
    const topWithout = without.find((s) => s.rosterId === 1)?.powerScore as number;

    // Had the zeros simply been fed through the composite, the leader would
    // score 76 rather than 95 — the whole 20-point roster-strength term lost.
    // Redistribution keeps the scale intact, so the two runs land within a
    // point of each other rather than a fifth of the range apart.
    expect(topWithout).toBeGreaterThan(90);
    expect(Math.abs(topWith - topWithout)).toBeLessThan(2);

    // The spread across the league is what the ranking reads, so it has to
    // survive too.
    const spread = (scores: { powerScore: number }[]) =>
      Math.max(...scores.map((s) => s.powerScore)) - Math.min(...scores.map((s) => s.powerScore));
    expect(spread(without)).toBeGreaterThan(spread(withProjections) * 0.9);
  });

  it('handles a league where every team is identical', () => {
    const flat = [1, 2, 3].map((rosterId) => ({
      rosterId, allPlayWinRate: 0.5, recentMean: 100, rosterStrength: 0, pointsFor: 100,
    }));
    const scored = powerScores(flat);
    expect(new Set(scored.map((s) => s.powerScore)).size).toBe(1);
    expect(scored.map((s) => s.powerRank).sort()).toEqual([1, 2, 3]);
  });

  it('returns nothing for an empty league', () => {
    expect(powerScores([])).toEqual([]);
  });
});
