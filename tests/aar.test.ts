import { describe, expect, it } from 'vitest';
import { buildAfterActionReport, VERDICT_COPY } from '@/lib/aar/build';
import { buildStatPacket } from '@/lib/compute/packet';
import type { StatPacket } from '@/lib/compute/types';
import {
  HISTORY,
  MATCHUPS,
  ODDS_BY_MATCHUP,
  PLAYERS,
  ROSTER_POSITIONS,
} from './fixtures/league';

const packet: StatPacket = buildStatPacket({
  leagueId: 'lg_1',
  leagueName: 'The League',
  season: '2026',
  week: 3,
  rosterPositions: ROSTER_POSITIONS,
  matchups: MATCHUPS,
  players: PLAYERS,
  history: HISTORY,
  oddsByMatchup: ODDS_BY_MATCHUP,
});

function aar(manager: string, matchupId: number) {
  return buildAfterActionReport({
    packet,
    matchupId,
    managerName: manager,
    snapshots: ODDS_BY_MATCHUP[matchupId],
  });
}

describe('buildAfterActionReport', () => {
  it('returns null for a manager who was not in the matchup', () => {
    expect(aar('Raj', 1)).toBeNull();
  });

  it('returns null for a matchup that does not exist', () => {
    expect(aar('Dave', 99)).toBeNull();
  });

  it('reads the result from the matchup regardless of which side the manager is', () => {
    const dave = aar('Dave', 1);
    const kim = aar('Kim', 1);

    expect(dave?.score).toBe(93.5);
    expect(dave?.opponentScore).toBe(99.9);
    expect(dave?.won).toBe(false);
    expect(dave?.isSideA).toBe(true);

    expect(kim?.score).toBe(99.9);
    expect(kim?.opponentScore).toBe(93.5);
    expect(kim?.won).toBe(true);
    expect(kim?.isSideA).toBe(false);
  });

  describe('verdict classification', () => {
    it('calls a loss the bench would have prevented what it is', () => {
      const dave = aar('Dave', 1);
      // Dave's optimal (114.4) clears Kim's actual (99.9).
      expect(dave?.verdict).toBe('lost_to_own_bench');
      expect(dave?.verdictDetail).toBe(VERDICT_COPY.lost_to_own_bench.explanation);
    });

    it('calls a win from a 6% low-water mark a heist', () => {
      expect(aar('Kim', 1)?.verdict).toBe('won_a_heist');
    });

    it('calls a straightforward win what it is', () => {
      expect(aar('Sam', 2)?.verdict).toBe('won_on_talent');
    });

    it('does not blame the bench when the bench could not have won it', () => {
      // Raj's optimal (53.2) is nowhere near Sam's 79.4.
      const raj = aar('Raj', 2);
      expect(raj?.verdict).not.toBe('lost_to_own_bench');
    });
  });

  describe('coaching report', () => {
    it('carries the ranked regrets from the packet', () => {
      const dave = aar('Dave', 1);
      expect(dave?.coaching.pointsLeft).toBe(20.9);
      expect(dave?.coaching.regrets[0]?.player).toBe('Dalton Kincaid');
    });

    it('names the swap that flips the result', () => {
      const dave = aar('Dave', 1);
      // Lost by 6.4; Kincaid over Otton is worth 20.9, so it wins by 14.5.
      expect(dave?.coaching.counterfactual).toBe('Starting Dalton Kincaid over Cade Otton wins by 14.5.');
    });

    it('offers no counterfactual to a winner', () => {
      expect(aar('Kim', 1)?.coaching.counterfactual).toBeNull();
    });

    it('offers no counterfactual when no single swap covers the margin', () => {
      // Raj lost by 31.1; his best swap is worth 4.9.
      expect(aar('Raj', 2)?.coaching.counterfactual).toBeNull();
    });
  });

  describe('luck split', () => {
    it('decomposes the margin into performance and lineup cost', () => {
      const dave = aar('Dave', 1);
      const daveTeam = packet.teams.find((t) => t.manager === 'Dave');
      const kimTeam = packet.teams.find((t) => t.manager === 'Kim');

      expect(dave?.luckSplit.ownVariance).toBeCloseTo(93.5 - (daveTeam?.seasonMean as number), 2);
      expect(dave?.luckSplit.opponentVariance).toBeCloseTo(99.9 - (kimTeam?.seasonMean as number), 2);
      expect(dave?.luckSplit.lineupCost).toBe(20.9);
      expect(dave?.luckSplit.margin).toBe(-6.4);
    });
  });

  describe('swing chart', () => {
    it('carries the persisted curve', () => {
      const dave = aar('Dave', 1);
      expect(dave?.swingChart).toHaveLength(6);
      expect(dave?.swingChart[0]?.winProbA).toBe(0.58);
    });

    it('carries the turning point and the peak', () => {
      const dave = aar('Dave', 1);
      expect(dave?.turningPoint?.player).toBe('Saquon Barkley');
      expect(dave?.peakWinProb?.manager).toBe('Dave');
      expect(dave?.peakWinProb?.value).toBe(0.94);
    });

    it('produces an empty chart rather than failing with no snapshots', () => {
      const report = buildAfterActionReport({ packet, matchupId: 1, managerName: 'Dave' });
      expect(report?.swingChart).toEqual([]);
      expect(report?.verdict).toBe('lost_to_own_bench');
    });
  });
});
