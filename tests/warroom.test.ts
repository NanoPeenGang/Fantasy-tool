import { describe, expect, it } from 'vitest';
import {
  firstPickRoundByPosition,
  liveWarnings,
  mineTendencies,
  positionalBias,
  reachRate,
  runDetector,
  teamHomerism,
  type HistoricalPick,
} from '@/lib/warroom/tendencies';

/**
 * Four drafts of the same room. Dave takes a quarterback in round 3 every year,
 * which is exactly the tell the live board is meant to surface.
 */
function picks(): HistoricalPick[] {
  const out: HistoricalPick[] = [];
  const seasons = ['2022', '2023', '2024', '2025'];

  seasons.forEach((season, index) => {
    const draftId = `draft_${season}`;
    // Dave: RB, RB, QB — a QB in round 3, four years running.
    out.push(
      { season, draftId, managerId: 'dave', playerId: `rb_a_${season}`, position: 'RB', nflTeam: 'BUF', round: 1, pickNo: 3, adp: 4 },
      { season, draftId, managerId: 'dave', playerId: `rb_b_${season}`, position: 'RB', nflTeam: 'BUF', round: 2, pickNo: 15, adp: 18 },
      { season, draftId, managerId: 'dave', playerId: `qb_${season}`, position: 'QB', nflTeam: 'BUF', round: 3, pickNo: 27, adp: 55 },
    );
    // Kim: patient at QB, and never reaches.
    out.push(
      { season, draftId, managerId: 'kim', playerId: `wr_a_${season}`, position: 'WR', nflTeam: 'PHI', round: 1, pickNo: 5, adp: 5 },
      { season, draftId, managerId: 'kim', playerId: `wr_b_${season}`, position: 'WR', nflTeam: 'MIN', round: 2, pickNo: 17, adp: 16 },
      { season, draftId, managerId: 'kim', playerId: `qb_k_${season}`, position: 'QB', nflTeam: 'DAL', round: 9 + index, pickNo: 100 + index, adp: 98 + index },
    );
  });

  return out;
}

describe('firstPickRoundByPosition', () => {
  it('finds the round a manager habitually takes a position', () => {
    const tendencies = firstPickRoundByPosition(picks());
    const daveQb = tendencies.find((t) => t.managerId === 'dave' && t.metricKey === 'first_qb_round');

    expect(daveQb?.value).toBe(3);
    expect(daveQb?.sampleSize).toBe(4);
  });

  it('separates managers with different habits', () => {
    const tendencies = firstPickRoundByPosition(picks());
    const kimQb = tendencies.find((t) => t.managerId === 'kim' && t.metricKey === 'first_qb_round');
    expect(kimQb?.value).toBeGreaterThan(9);
  });

  it('counts only the first pick of a position in each draft', () => {
    const tendencies = firstPickRoundByPosition(picks());
    const daveRb = tendencies.find((t) => t.managerId === 'dave' && t.metricKey === 'first_rb_round');
    // Two RBs per draft, but only the round-1 one counts.
    expect(daveRb?.value).toBe(1);
    expect(daveRb?.sampleSize).toBe(4);
  });
});

describe('reachRate', () => {
  it('flags the manager who takes players well ahead of consensus', () => {
    const tendencies = reachRate(picks());
    const dave = tendencies.find((t) => t.managerId === 'dave');
    // Dave's QB goes 28 picks ahead of ADP every year: one reach in three picks.
    expect(dave?.value).toBeCloseTo(1 / 3, 4);
  });

  it('gives a disciplined drafter a rate of zero', () => {
    const tendencies = reachRate(picks());
    expect(tendencies.find((t) => t.managerId === 'kim')?.value).toBe(0);
  });

  it('is simply absent when no ADP is available', () => {
    const noAdp = picks().map((pick) => ({ ...pick, adp: null }));
    expect(reachRate(noAdp)).toEqual([]);
  });
});

describe('positionalBias', () => {
  it('reports the share of picks spent per position', () => {
    const tendencies = positionalBias(picks());
    const daveRb = tendencies.find((t) => t.managerId === 'dave' && t.metricKey === 'bias_rb');
    expect(daveRb?.value).toBeCloseTo(2 / 3, 4);
  });
});

describe('teamHomerism', () => {
  it('finds the team a manager over-drafts', () => {
    const tendency = teamHomerism(picks()).find((t) => t.managerId === 'dave');
    expect(tendency?.detail.team).toBe('BUF');
    expect(tendency?.value).toBe(1);
    expect(tendency?.detail.isNotable).toBe(true);
  });

  it('does not flag a spread-out drafter', () => {
    const tendency = teamHomerism(picks()).find((t) => t.managerId === 'kim');
    expect(tendency?.value).toBeLessThanOrEqual(0.5);
  });

  it('ignores managers with too little history to say anything', () => {
    const thin = picks().filter((p) => p.season === '2022' && p.managerId === 'dave');
    expect(teamHomerism(thin)).toEqual([]);
  });
});

describe('liveWarnings', () => {
  const tendencies = mineTendencies(picks());
  const managerNames = { dave: 'Dave', kim: 'Kim' };

  it('warns about the round a manager is about to reach in', () => {
    const warnings = liveWarnings({
      tendencies,
      managerNames,
      picksAway: { dave: 6, kim: 4 },
      currentRound: 3,
    });

    expect(warnings.some((w) => w.includes('Dave has taken a QB in round 3'))).toBe(true);
    expect(warnings.some((w) => w.includes('They pick in 6'))).toBe(true);
  });

  it('stays quiet in a round the tendency does not apply to', () => {
    const warnings = liveWarnings({
      tendencies,
      managerNames,
      picksAway: { dave: 6 },
      currentRound: 7,
    });
    expect(warnings.some((w) => w.includes('QB in round 3'))).toBe(false);
  });

  it('will not warn from a sample too thin to trust', () => {
    const thin = mineTendencies(picks().filter((p) => p.season === '2022'));
    const warnings = liveWarnings({
      tendencies: thin,
      managerNames,
      picksAway: { dave: 6 },
      currentRound: 3,
      minSample: 3,
    });
    expect(warnings).toEqual([]);
  });

  it('says nothing about a manager whose turn is not tracked', () => {
    const warnings = liveWarnings({
      tendencies, managerNames, picksAway: {}, currentRound: 3,
    });
    expect(warnings).toEqual([]);
  });
});

describe('runDetector', () => {
  it('detects a positional run', () => {
    const result = runDetector({
      recentPicks: ['WR', 'RB', 'RB', 'WR', 'RB'],
      position: 'RB',
      picksUntilYourTurn: 6,
      tierRemaining: 2,
    });

    expect(result.runDetected).toBe(true);
    expect(result.recentCount).toBe(3);
    expect(result.rate).toBeCloseTo(0.6, 4);
  });

  it('does not cry run over a normal draft', () => {
    const result = runDetector({
      recentPicks: ['WR', 'TE', 'QB', 'WR', 'RB'],
      position: 'RB',
      picksUntilYourTurn: 6,
      tierRemaining: 3,
    });
    expect(result.runDetected).toBe(false);
  });

  it('prices survival lower the longer the wait', () => {
    const base = { recentPicks: ['RB', 'RB', 'WR', 'RB', 'RB'], position: 'RB', tierRemaining: 2 };
    const soon = runDetector({ ...base, picksUntilYourTurn: 2 });
    const later = runDetector({ ...base, picksUntilYourTurn: 10 });

    expect(soon.survivalProbability).toBeGreaterThan(later.survivalProbability);
  });

  it('prices survival higher the deeper the tier', () => {
    const base = { recentPicks: ['RB', 'RB', 'WR', 'RB', 'RB'], position: 'RB', picksUntilYourTurn: 6 };
    const thin = runDetector({ ...base, tierRemaining: 1 });
    const deep = runDetector({ ...base, tierRemaining: 8 });

    expect(deep.survivalProbability).toBeGreaterThan(thin.survivalProbability);
  });

  it('reports certain death when the tier is already empty', () => {
    const result = runDetector({
      recentPicks: ['RB', 'RB', 'RB'],
      position: 'RB',
      picksUntilYourTurn: 3,
      tierRemaining: 0,
    });
    expect(result.survivalProbability).toBe(0);
  });

  it('handles an empty draft board', () => {
    const result = runDetector({
      recentPicks: [], position: 'RB', picksUntilYourTurn: 5, tierRemaining: 4,
    });
    expect(result.runDetected).toBe(false);
    expect(result.rate).toBe(0);
    expect(result.survivalProbability).toBe(1);
  });
});
