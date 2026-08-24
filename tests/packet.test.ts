import { describe, expect, it } from 'vitest';
import { buildStatPacket } from '@/lib/compute/packet';
import {
  HISTORY,
  MATCHUPS,
  ODDS_BY_MATCHUP,
  PLAYERS,
  PREVIOUS_POWER_RANKS,
  ROSTER_POSITIONS,
} from './fixtures/league';
import type { StatPacket } from '@/lib/compute/types';

function packet(): StatPacket {
  return buildStatPacket({
    leagueId: 'lg_1',
    leagueName: 'The League',
    season: '2026',
    week: 3,
    rosterPositions: ROSTER_POSITIONS,
    matchups: MATCHUPS,
    players: PLAYERS,
    history: HISTORY,
    oddsByMatchup: ODDS_BY_MATCHUP,
    previousPowerRanks: PREVIOUS_POWER_RANKS,
    computedAt: '2026-10-19T05:00:00.000Z',
  });
}

describe('buildStatPacket', () => {
  it('produces one line per team, ordered by power rank', () => {
    const p = packet();
    expect(p.teams).toHaveLength(4);
    expect(p.teams.map((t) => t.powerRank)).toEqual([1, 2, 3, 4]);
  });

  it('carries the league identity and the week it was computed for', () => {
    const p = packet();
    expect(p).toMatchObject({ leagueId: 'lg_1', season: '2026', week: 3 });
  });

  describe('team lines', () => {
    it('scores the coaching report against the roster the manager owned', () => {
      const dave = packet().teams.find((t) => t.manager === 'Dave');
      expect(dave?.score).toBe(93.5);
      // Kincaid (24.1) replaces the started TE (3.2): 93.5 - 3.2 + 24.1.
      expect(dave?.optimal).toBe(114.4);
      expect(dave?.benchPointsLeft).toBe(20.9);
      expect(dave?.coachingEfficiency).toBeCloseTo(93.5 / 114.4, 4);
    });

    it('carries the bench regret detail the recap and AAR quote', () => {
      const dave = packet().teams.find((t) => t.manager === 'Dave');
      const worst = dave?.benchRegret[0];
      expect(worst).toMatchObject({
        player: 'Dalton Kincaid',
        points: 24.1,
        replacing: 'Cade Otton',
        replacingPoints: 3.2,
        delta: 20.9,
      });
    });

    it('leaves bench regret empty for a manager with nothing to regret', () => {
      const kim = packet().teams.find((t) => t.manager === 'Kim');
      expect(kim?.benchRegret).toEqual([]);
    });

    it('gives a manager who started their best lineup full efficiency', () => {
      const kim = packet().teams.find((t) => t.manager === 'Kim');
      expect(kim?.coachingEfficiency).toBe(1);
      expect(kim?.benchPointsLeft).toBe(0);
    });

    it('computes all-play alongside the actual record', () => {
      const sam = packet().teams.find((t) => t.manager === 'Sam');
      // Sam is 3-0 head to head across the three fixture weeks.
      expect(sam?.record).toEqual({ w: 3, l: 0, t: 0 });
      expect((sam?.allPlay.w ?? 0) + (sam?.allPlay.l ?? 0)).toBe(9);
    });

    it('flags the lucky team with a positive luck index', () => {
      const p = packet();
      const sam = p.teams.find((t) => t.manager === 'Sam');
      const kim = p.teams.find((t) => t.manager === 'Kim');
      // Sam wins every week without ever being the league's best scorer.
      expect(sam?.luckIndex).toBeGreaterThan(0);
      expect(kim?.luckIndex).toBeLessThanOrEqual(0);
    });

    it('reports movement against last week ranks', () => {
      const p = packet();
      for (const team of p.teams) {
        const previous = PREVIOUS_POWER_RANKS[team.managerId] as number;
        expect(team.rankDelta).toBe(previous - team.powerRank);
      }
    });
  });

  describe('matchup lines', () => {
    it('reads the opening line off the first persisted snapshot', () => {
      const m = packet().matchups.find((x) => x.matchupId === 1);
      expect(m?.opening?.winProbA).toBe(0.58);
    });

    it('records the peak and the comeback that beat it', () => {
      const m = packet().matchups.find((x) => x.matchupId === 1);
      expect(m?.peakWinProb).toMatchObject({ manager: 'Dave', value: 0.94 });
      // Kim's low-water mark: 1 - 0.94.
      expect(m?.comebackIndex).toBeCloseTo(0.06, 6);
    });

    it('calls a favourite losing a closing upset', () => {
      const m = packet().matchups.find((x) => x.matchupId === 1);
      expect(m?.closingUpset).toBe(true);
    });

    it('attributes the turning point to the player who caused it', () => {
      const m = packet().matchups.find((x) => x.matchupId === 1);
      expect(m?.turningPoint?.player).toBe('Saquon Barkley');
      expect(m?.turningPoint?.swing).toBeCloseTo(0.53, 6);
      expect(m?.turningPoint?.description).toContain('Saquon Barkley');
    });

    it('identifies a loss the loser own bench would have prevented', () => {
      const m = packet().matchups.find((x) => x.matchupId === 1);
      // Dave's optimal (114.4) clears Kim's actual (99.9).
      expect(m?.coachingLoss).toBe(true);
      expect(m?.marginVsBench).toContain('Dave left 20.9 on the bench');
    });

    it('flags the blowout nobody was ever alive in', () => {
      const m = packet().matchups.find((x) => x.matchupId === 2);
      expect(m?.deadOnArrival).toBe(true);
      expect(m?.closingUpset).toBe(false);
    });
  });

  describe('awards', () => {
    const byKey = (p: StatPacket, key: string) => p.awards.find((a) => a.key === key);

    it('gives Sh*t the Bed to the lowest score', () => {
      const award = byKey(packet(), 'shit_the_bed');
      expect(award?.manager).toBe('Raj');
      expect(award?.value).toBe(48.3);
    });

    it('gives Cardiac Kid to the narrowest win', () => {
      const award = byKey(packet(), 'cardiac_kid');
      expect(award?.manager).toBe('Kim');
      expect(award?.value).toBeCloseTo(6.4, 6);
    });

    it('gives Bench Warmer to the most points left sitting', () => {
      const award = byKey(packet(), 'bench_warmer');
      expect(award?.manager).toBe('Dave');
      expect(award?.value).toBe(20.9);
    });

    it('gives Heist to the lowest comeback index', () => {
      const award = byKey(packet(), 'heist');
      expect(award?.manager).toBe('Kim');
      expect(award?.value).toBeCloseTo(0.06, 6);
    });

    it('gives Coward to the manager who started a player already ruled out', () => {
      const award = byKey(packet(), 'coward');
      expect(award?.manager).toBe('Sam');
      expect(award?.evidence).toMatchObject({ outPlayers: ['Isiah Pacheco'] });
    });

    it('prices the Bagholder in win probability, not points', () => {
      const award = byKey(packet(), 'bagholder');
      expect(award?.manager).toBe('Dave');
      expect(award?.value).toBeGreaterThan(0);
      expect(award?.value).toBeLessThan(1);
      expect(award?.evidence).toMatchObject({ benched: 'Dalton Kincaid' });
    });

    it('attaches evidence to every award it hands out', () => {
      for (const award of packet().awards) {
        expect(Object.keys(award.evidence).length).toBeGreaterThan(0);
        expect(award.manager).toBeTruthy();
        expect(award.label).toBeTruthy();
      }
    });
  });

  describe('hot players and team of the week', () => {
    it('ranks the week top scorers league-wide', () => {
      const hot = packet().hotPlayers;
      expect(hot[0]?.player).toBe('Jalen Hurts');
      expect(hot[0]?.points).toBe(27.8);
      expect(hot[0]?.rosteredBy).toBe('Kim');
    });

    it('flags a top scorer who was left on a bench', () => {
      const kincaid = packet().hotPlayers.find((p) => p.player === 'Dalton Kincaid');
      expect(kincaid?.started).toBe(false);
    });

    it('builds the optimal lineup across every roster in the league', () => {
      const totw = packet().teamOfTheWeek;
      expect(totw).not.toBeNull();
      // One entry per scoring slot, and every slot filled in a league this size.
      expect(totw?.slots).toHaveLength(7);
      // The best QB in the league starts at QB.
      expect(totw?.slots.find((s) => s.slot === 'QB')?.player).toBe('Jalen Hurts');
    });

    it('reports how much of the team of the week was actually started', () => {
      const totw = packet().teamOfTheWeek;
      expect(totw?.startedTotal).toBeLessThanOrEqual(totw?.total as number);
      expect(totw?.startedTotal).toBeGreaterThan(0);
    });
  });

  describe('degenerate inputs', () => {
    it('handles a roster with a bye and no opponent', () => {
      const p = buildStatPacket({
        leagueId: 'lg_1', leagueName: 'The League', season: '2026', week: 3,
        rosterPositions: ROSTER_POSITIONS,
        matchups: [{ matchupId: 1, a: MATCHUPS[0]!.a, b: null }],
        players: PLAYERS,
        history: HISTORY,
      });
      expect(p.matchups[0]?.b).toBe('');
      expect(p.matchups[0]?.marginVsBench).toBe('no opponent this week');
      expect(p.matchups[0]?.coachingLoss).toBe(false);
    });

    it('produces a packet with no odds history at all', () => {
      const p = buildStatPacket({
        leagueId: 'lg_1', leagueName: 'The League', season: '2026', week: 3,
        rosterPositions: ROSTER_POSITIONS,
        matchups: MATCHUPS, players: PLAYERS, history: HISTORY,
      });
      // Everything odds-derived is absent rather than fabricated.
      expect(p.matchups[0]?.opening).toBeNull();
      expect(p.matchups[0]?.comebackIndex).toBeNull();
      expect(p.matchups[0]?.turningPoint).toBeNull();
      // Everything Sleeper-derived still works.
      expect(p.teams).toHaveLength(4);
      expect(p.awards.find((a) => a.key === 'shit_the_bed')?.manager).toBe('Raj');
      // The Heist award needs a curve, so it is simply not awarded.
      expect(p.awards.find((a) => a.key === 'heist')).toBeUndefined();
    });

    it('does not crash on an empty league', () => {
      const p = buildStatPacket({
        leagueId: 'lg_1', leagueName: 'Empty', season: '2026', week: 1,
        rosterPositions: ROSTER_POSITIONS, matchups: [], players: {},
        history: { weeks: [] },
      });
      expect(p.teams).toEqual([]);
      expect(p.awards).toEqual([]);
      expect(p.teamOfTheWeek).toBeNull();
    });
  });
});
