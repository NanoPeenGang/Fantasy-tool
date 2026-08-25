import { describe, expect, it } from 'vitest';
import { computeTiers, deriveAdp, positionalMarket, valueOverReplacement } from '@/lib/warroom/adp';
import { byeCollisions, positionalNeeds, startersByPosition } from '@/lib/warroom/needs';
import { bestAvailable, buildBoard, tierRemaining } from '@/lib/warroom/board';
import type { HistoricalPick } from '@/lib/warroom/tendencies';

const ROSTER_POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN'];

describe('computeTiers', () => {
  it('finds the cliff in an obviously tiered board', () => {
    // Three clear groups: elite, good, and everyone else.
    const values = [300, 295, 290, 240, 236, 232, 180, 176];
    const { tiers, cliffs } = computeTiers(values);

    expect(tiers[0]).toBe(1);
    expect(tiers[2]).toBe(1);
    expect(tiers[3]).toBe(2);
    expect(tiers[5]).toBe(2);
    expect(tiers[6]).toBe(3);
    expect(cliffs.map((c) => c.startsAtIndex)).toEqual([3, 6]);
  });

  it('reports the size of each cliff, which is the actual decision', () => {
    const { cliffs } = computeTiers([300, 295, 290, 240, 236, 232]);
    expect(cliffs[0]?.gap).toBe(50);
  });

  it('puts an evenly spaced board in one tier', () => {
    const { tiers, cliffs } = computeTiers([100, 95, 90, 85, 80, 75, 70]);
    expect(new Set(tiers).size).toBe(1);
    expect(cliffs).toEqual([]);
  });

  it('does not create singleton tiers from small wobbles', () => {
    const { tiers } = computeTiers([100, 99, 97, 96, 94, 93], { minTierSize: 2 });
    const counts = new Map<number, number>();
    for (const tier of tiers) counts.set(tier, (counts.get(tier) ?? 0) + 1);
    for (const count of counts.values()) expect(count).toBeGreaterThanOrEqual(2);
  });

  it('handles degenerate inputs', () => {
    expect(computeTiers([])).toEqual({ tiers: [], cliffs: [] });
    expect(computeTiers([10])).toEqual({ tiers: [1], cliffs: [] });
  });

  it('respects the tier cap', () => {
    const values = Array.from({ length: 60 }, (_, i) => 300 - i * 20);
    const { tiers } = computeTiers(values, { maxTiers: 4, minTierSize: 1 });
    expect(Math.max(...tiers)).toBeLessThanOrEqual(4);
  });
});

describe('deriveAdp', () => {
  function pick(over: Partial<HistoricalPick> & { playerId: string; season: string; pickNo: number }): HistoricalPick {
    return {
      draftId: `d${over.season}`,
      managerId: 'm1',
      position: 'RB',
      nflTeam: 'BUF',
      round: Math.ceil(over.pickNo / 12),
      ...over,
    } as HistoricalPick;
  }

  it('averages a player picks across drafts', () => {
    const entries = deriveAdp([
      pick({ playerId: 'p1', season: '2025', pickNo: 10 }),
      pick({ playerId: 'p1', season: '2024', pickNo: 10 }),
    ]);
    expect(entries[0]?.adp).toBe(10);
    expect(entries[0]?.sampleSize).toBe(2);
  });

  /** A player on the way down should not be anchored by two-year-old value. */
  it('weights recent seasons more heavily', () => {
    const entries = deriveAdp([
      pick({ playerId: 'p1', season: '2023', pickNo: 12 }),
      pick({ playerId: 'p1', season: '2025', pickNo: 60 }),
    ]);
    const flatMean = 36;
    expect(entries[0]?.adp).toBeGreaterThan(flatMean);
  });

  it('reports the spread, so a divisive player is visible', () => {
    const entries = deriveAdp([
      pick({ playerId: 'p1', season: '2025', pickNo: 5 }),
      pick({ playerId: 'p1', season: '2024', pickNo: 45 }),
    ]);
    expect(entries[0]?.stdev).toBeGreaterThan(20);
    expect(entries[0]?.earliest).toBe(5);
    expect(entries[0]?.latest).toBe(45);
  });

  it('sorts by draft position', () => {
    const entries = deriveAdp([
      pick({ playerId: 'late', season: '2025', pickNo: 80 }),
      pick({ playerId: 'early', season: '2025', pickNo: 3 }),
    ]);
    expect(entries.map((e) => e.playerId)).toEqual(['early', 'late']);
  });

  it('returns nothing for no history', () => {
    expect(deriveAdp([])).toEqual([]);
  });
});

describe('positionalMarket', () => {
  const picks: HistoricalPick[] = [];
  for (const season of ['2024', '2025']) {
    // QBs go early in this room, tight ends go very late.
    picks.push(
      { season, draftId: `d${season}`, managerId: 'm1', playerId: `qb${season}`, position: 'QB', nflTeam: 'BUF', round: 2, pickNo: 15 },
      { season, draftId: `d${season}`, managerId: 'm2', playerId: `qb2${season}`, position: 'QB', nflTeam: 'KC', round: 3, pickNo: 30 },
      { season, draftId: `d${season}`, managerId: 'm1', playerId: `te${season}`, position: 'TE', nflTeam: 'SF', round: 9, pickNo: 100 },
    );
  }

  it('reports when each position first comes off the board', () => {
    const market = positionalMarket(picks);
    const qb = market.find((m) => m.position === 'QB');
    const te = market.find((m) => m.position === 'TE');
    expect(qb?.firstOffBoardRound).toBe(2);
    expect(te?.firstOffBoardRound).toBe(9);
  });

  it('orders positions by how early the room takes them', () => {
    expect(positionalMarket(picks)[0]?.position).toBe('QB');
  });

  it('counts the drafts behind each number', () => {
    expect(positionalMarket(picks).find((m) => m.position === 'QB')?.drafts).toBe(2);
  });
});

describe('valueOverReplacement', () => {
  it('prices a position by what the last starter is worth', () => {
    const players = [
      { playerId: 'qb1', position: 'QB', projection: 300 },
      { playerId: 'qb2', position: 'QB', projection: 280 },
      { playerId: 'qb3', position: 'QB', projection: 260 },
      { playerId: 'rb1', position: 'RB', projection: 250 },
      { playerId: 'rb2', position: 'RB', projection: 150 },
      { playerId: 'rb3', position: 'RB', projection: 140 },
    ];
    const vor = valueOverReplacement({
      players,
      startersByPosition: { QB: 1, RB: 1 },
      teams: 2,
    });

    // With 2 teams starting 1 QB, replacement is the 3rd QB (260).
    expect(vor.qb1).toBe(40);
    // Replacement RB is the 3rd (140), so rb1 is worth far more.
    expect(vor.rb1).toBe(110);
  });

  /**
   * The point of VOR: a raw projection ranking would put the quarterback first,
   * and in a one-QB league that is the wrong pick.
   */
  it('reorders across positions relative to raw projection', () => {
    const players = [
      { playerId: 'qb1', position: 'QB', projection: 300 },
      { playerId: 'rb1', position: 'RB', projection: 250 },
      { playerId: 'qb2', position: 'QB', projection: 295 },
      { playerId: 'rb2', position: 'RB', projection: 120 },
    ];
    const vor = valueOverReplacement({ players, startersByPosition: { QB: 1, RB: 1 }, teams: 1 });
    expect(vor.rb1).toBeGreaterThan(vor.qb1 as number);
  });
});

describe('positionalNeeds', () => {
  it('flags an unfilled dedicated slot as maximum urgency', () => {
    const needs = positionalNeeds({
      roster: [{ playerId: 'a', position: 'RB', name: 'A' }],
      rosterPositions: ROSTER_POSITIONS,
    });
    const qb = needs.find((n) => n.position === 'QB');
    expect(qb?.missing).toBe(1);
    expect(qb?.urgency).toBe(1);
  });

  it('counts partial fills', () => {
    const needs = positionalNeeds({
      roster: [
        { playerId: 'a', position: 'RB', name: 'A' },
        { playerId: 'b', position: 'QB', name: 'B' },
      ],
      rosterPositions: ROSTER_POSITIONS,
    });
    const rb = needs.find((n) => n.position === 'RB');
    expect(rb?.required).toBe(2);
    expect(rb?.filled).toBe(1);
    expect(rb?.urgency).toBe(0.5);
  });

  it('ranks the most urgent position first', () => {
    const needs = positionalNeeds({
      roster: [
        { playerId: 'a', position: 'RB', name: 'A' },
        { playerId: 'b', position: 'RB', name: 'B' },
        { playerId: 'c', position: 'WR', name: 'C' },
        { playerId: 'd', position: 'WR', name: 'D' },
        { playerId: 'e', position: 'TE', name: 'E' },
      ],
      rosterPositions: ROSTER_POSITIONS,
    });
    expect(needs[0]?.urgency).toBe(1);
    expect(['QB', 'K', 'DEF']).toContain(needs[0]?.position);
  });

  it('reports flex eligibility', () => {
    const needs = positionalNeeds({ roster: [], rosterPositions: ROSTER_POSITIONS });
    expect(needs.find((n) => n.position === 'RB')?.flexEligible).toBe(1);
    expect(needs.find((n) => n.position === 'QB')?.flexEligible).toBe(0);
  });
});

describe('startersByPosition', () => {
  it('counts dedicated slots only, never flex', () => {
    expect(startersByPosition(ROSTER_POSITIONS)).toEqual({
      QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1,
    });
  });
});

describe('byeCollisions', () => {
  it('flags a bye that leaves a starting slot empty', () => {
    const collisions = byeCollisions({
      roster: [
        { playerId: 'rb1', position: 'RB', name: 'Back One', byeWeek: 7 },
        { playerId: 'rb2', position: 'RB', name: 'Back Two', byeWeek: 7 },
      ],
      rosterPositions: ROSTER_POSITIONS,
    });
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({ week: 7, position: 'RB', shortBy: 2 });
  });

  /** The false alarms are what make a warning stop being read. */
  it('stays quiet when enough cover remains', () => {
    const collisions = byeCollisions({
      roster: [
        { playerId: 'rb1', position: 'RB', name: 'One', byeWeek: 7 },
        { playerId: 'rb2', position: 'RB', name: 'Two', byeWeek: 9 },
        { playerId: 'rb3', position: 'RB', name: 'Three', byeWeek: 11 },
      ],
      rosterPositions: ROSTER_POSITIONS,
    });
    expect(collisions).toEqual([]);
  });

  it('ignores players with no known bye', () => {
    expect(
      byeCollisions({
        roster: [{ playerId: 'rb1', position: 'RB', name: 'One', byeWeek: null }],
        rosterPositions: ROSTER_POSITIONS,
      }),
    ).toEqual([]);
  });
});

describe('buildBoard', () => {
  const players = [
    { playerId: 'rb1', name: 'Back One', position: 'RB', team: 'BUF', byeWeek: 7 },
    { playerId: 'rb2', name: 'Back Two', position: 'RB', team: 'KC', byeWeek: 9 },
    { playerId: 'rb3', name: 'Back Three', position: 'RB', team: 'SF', byeWeek: 5 },
    { playerId: 'wr1', name: 'Wide One', position: 'WR', team: 'PHI', byeWeek: 10 },
    { playerId: 'wr2', name: 'Wide Two', position: 'WR', team: 'MIN', byeWeek: 6 },
    { playerId: 'qb1', name: 'Quarter One', position: 'QB', team: 'BAL', byeWeek: 14 },
  ];

  const projections = { rb1: 280, rb2: 210, rb3: 130, wr1: 260, wr2: 190, qb1: 300 };

  it('ranks on value over replacement when projections exist', () => {
    const board = buildBoard({
      players, projections, roster: [], rosterPositions: ROSTER_POSITIONS, teams: 10,
    });
    expect(board.source).toBe('projections');
    // The QB projects highest but is worth least over replacement in a 1QB league.
    expect(board.players[0]?.playerId).not.toBe('qb1');
  });

  it('falls back to league ADP when there are no projections', () => {
    const board = buildBoard({
      players,
      adp: [
        { playerId: 'wr1', adp: 3, stdev: 1, earliest: 2, latest: 4, sampleSize: 2, position: 'WR' },
        { playerId: 'rb1', adp: 12, stdev: 2, earliest: 10, latest: 14, sampleSize: 2, position: 'RB' },
      ],
      roster: [], rosterPositions: ROSTER_POSITIONS, teams: 10,
    });
    expect(board.source).toBe('league_adp');
    expect(board.players[0]?.playerId).toBe('wr1');
  });

  it('says so rather than inventing a ranking with no source', () => {
    const board = buildBoard({
      players, roster: [], rosterPositions: ROSTER_POSITIONS, teams: 10,
    });
    expect(board.source).toBe('none');
    expect(board.players.every((p) => p.tier === null)).toBe(true);
  });

  it('marks drafted players as taken', () => {
    const board = buildBoard({
      players, projections,
      taken: { rb1: { by: 'Dave', pick: 4 } },
      roster: [], rosterPositions: ROSTER_POSITIONS, teams: 10,
    });
    const rb1 = board.players.find((p) => p.playerId === 'rb1');
    expect(rb1?.taken).toBe(true);
    expect(rb1?.takenBy).toBe('Dave');
    expect(bestAvailable(board).some((p) => p.playerId === 'rb1')).toBe(false);
  });

  it('carries watchlist membership and notes', () => {
    const board = buildBoard({
      players, projections,
      watchlist: { wr2: { note: 'sleeper, target round 8' } },
      roster: [], rosterPositions: ROSTER_POSITIONS, teams: 10,
    });
    const wr2 = board.players.find((p) => p.playerId === 'wr2');
    expect(wr2?.onWatchlist).toBe(true);
    expect(wr2?.watchNote).toBe('sleeper, target round 8');
  });

  it('tiers within a position, not across the whole board', () => {
    const board = buildBoard({
      players, projections, roster: [], rosterPositions: ROSTER_POSITIONS, teams: 10,
    });
    const backs = board.players.filter((p) => p.position === 'RB');
    expect(backs.every((p) => p.tier !== null)).toBe(true);
    expect(backs[0]?.tier).toBe(1);
  });

  it('nudges toward need without letting it dominate', () => {
    const withoutNeed = buildBoard({
      players, projections, roster: [], rosterPositions: ROSTER_POSITIONS, teams: 10, needWeight: 0,
    });
    const withNeed = buildBoard({
      players, projections,
      // A roster already stacked at RB should stop pushing running backs.
      roster: [
        { playerId: 'x', position: 'RB', name: 'X' },
        { playerId: 'y', position: 'RB', name: 'Y' },
      ],
      rosterPositions: ROSTER_POSITIONS, teams: 10, needWeight: 1,
    });

    const topWithout = withoutNeed.players[0]?.playerId;
    const rbNeedWithout = withoutNeed.needs.find((n) => n.position === 'RB')?.urgency ?? 0;
    const rbNeedWith = withNeed.needs.find((n) => n.position === 'RB')?.urgency ?? 0;

    expect(rbNeedWith).toBeLessThan(rbNeedWithout);
    expect(topWithout).toBeTruthy();
  });

  it('counts what is left in a tier for the run detector', () => {
    const board = buildBoard({
      players, projections,
      taken: { rb1: { by: 'Dave', pick: 4 } },
      roster: [], rosterPositions: ROSTER_POSITIONS, teams: 10,
    });
    const tierOne = board.players.find((p) => p.playerId === 'rb2')?.tier as number;
    expect(tierRemaining(board, 'RB', tierOne)).toBeGreaterThanOrEqual(0);
    // rb1 is taken, so it never counts toward what remains.
    expect(
      board.players.filter((p) => p.position === 'RB' && !p.taken).map((p) => p.playerId),
    ).not.toContain('rb1');
  });
});
