import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration tests for the repository layer, against a real Postgres.
 *
 * Everything else in this suite is pure and runs anywhere. This file is the
 * opposite: it exists because the SQL had never been executed, and typechecking
 * a query string proves nothing about whether it parses, whether the column
 * exists, or whether an ON CONFLICT target matches a real constraint.
 *
 * Set TEST_DATABASE_URL to run it. Without one the suite skips rather than
 * fails, so `npm test` stays green on a machine with no database.
 */
const TEST_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_URL ? describe : describe.skip;

if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

describeDb('repository layer against a real Postgres', () => {
  let db: typeof import('@/lib/db/client');
  let queries: typeof import('@/lib/db/queries');
  let leagueId: string;

  beforeAll(async () => {
    db = await import('@/lib/db/client');
    queries = await import('@/lib/db/queries');
    await db.applySchema();
    // A clean slate per run, so repeated runs do not accumulate fixtures.
    await db.query('DELETE FROM leagues WHERE sleeper_league_id = $1', ['test_league_1']);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('DELETE FROM leagues WHERE sleeper_league_id = $1', ['test_league_1']);
    await db.db().end();
  });

  describe('databaseStatus', () => {
    it('reports a migrated database as ready', async () => {
      const status = await db.databaseStatus();
      expect(status.configured).toBe(true);
      expect(status.reachable).toBe(true);
      expect(status.migrated).toBe(true);
      expect(status.missingTables).toEqual([]);
    });

    it('names the environment variable it read', async () => {
      const status = await db.databaseStatus();
      expect(status.source).toBe('DATABASE_URL');
    });
  });

  describe('applySchema', () => {
    it('is idempotent', async () => {
      await expect(db.applySchema()).resolves.toEqual({ applied: true });
      await expect(db.applySchema()).resolves.toEqual({ applied: true });
    });
  });

  describe('leagues', () => {
    it('inserts a league', async () => {
      const league = await queries.upsertLeague({
        sleeperLeagueId: 'test_league_1',
        season: '2026',
        name: 'The League',
        scoringSettings: { rec: 0.5, pass_td: 4 },
        rosterPositions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN'],
        previousLeagueId: null,
      });
      leagueId = league.id;
      expect(league.name).toBe('The League');
      // jsonb round-trips as a parsed object, not a string.
      expect(league.scoring_settings.rec).toBe(0.5);
      expect(league.roster_positions).toContain('FLEX');
    });

    it('upserts on the natural key rather than duplicating', async () => {
      const again = await queries.upsertLeague({
        sleeperLeagueId: 'test_league_1',
        season: '2026',
        name: 'Renamed League',
        scoringSettings: { rec: 1 },
        rosterPositions: ['QB'],
        previousLeagueId: null,
      });
      expect(again.id).toBe(leagueId);
      expect(again.name).toBe('Renamed League');
    });

    it('reads back the settings the report pipeline needs', async () => {
      await queries.updateLeagueSettings(leagueId, {
        heatCeiling: 'unhinged',
        voicePreset: 'noir',
      });
      const league = await queries.getLeague(leagueId);
      expect(league?.heat_ceiling).toBe('unhinged');
      expect(league?.voice_preset).toBe('noir');
    });
  });

  describe('managers and rosters', () => {
    it('inserts managers and returns their ids', async () => {
      const managers = await queries.upsertManagers(leagueId, [
        { sleeperUserId: 'u1', displayName: 'Dave', teamName: 'Dave Matthews Band', avatar: null },
        { sleeperUserId: 'u2', displayName: 'Kim', teamName: 'Hurts Donut', avatar: null },
      ]);
      expect(managers).toHaveLength(2);
      expect(managers[0]?.roast_opt_down).toBe(false);
    });

    it('records a roast opt-down', async () => {
      const managers = await queries.listManagers(leagueId);
      const dave = managers.find((m) => m.display_name === 'Dave');
      await queries.setRoastOptDown(dave!.id, true);
      const after = await queries.listManagers(leagueId);
      expect(after.find((m) => m.display_name === 'Dave')?.roast_opt_down).toBe(true);
    });

    it('links rosters to managers', async () => {
      const managers = await queries.listManagers(leagueId);
      await queries.upsertRosters(leagueId, [
        {
          rosterId: 1,
          managerId: managers[0]!.id,
          players: ['p1', 'p2'],
          starters: ['p1'],
          settings: { wins: 2, losses: 1 },
        },
        {
          rosterId: 2,
          managerId: managers[1]!.id,
          players: ['p3'],
          starters: ['p3'],
          settings: { wins: 1, losses: 2 },
        },
      ]);
      const rosters = await queries.listRosters(leagueId);
      expect(rosters).toHaveLength(2);
      expect(rosters[0]?.players).toEqual(['p1', 'p2']);
    });
  });

  describe('matchups and season history', () => {
    it('stores a matchup and returns its row id', async () => {
      const row = await queries.upsertMatchup({
        leagueId, week: 1, matchupId: 1,
        rosterA: 1, rosterB: 2, pointsA: 100.5, pointsB: 90.25, status: 'final',
      });
      expect(row.id).toBeTruthy();
      expect(Number(row.points_a)).toBe(100.5);
    });

    it('expands each stored matchup into two history rows', async () => {
      await queries.upsertMatchup({
        leagueId, week: 2, matchupId: 1,
        rosterA: 1, rosterB: 2, pointsA: 80, pointsB: 110, status: 'final',
      });

      const history = await queries.seasonHistory(leagueId, 2);
      expect(history.weeks).toHaveLength(4);

      const rosterOneWeekOne = history.weeks.find((w) => w.week === 1 && w.rosterId === 1);
      expect(rosterOneWeekOne?.score).toBe(100.5);
      expect(rosterOneWeekOne?.opponentRosterId).toBe(2);
      expect(rosterOneWeekOne?.opponentScore).toBe(90.25);
    });

    it('excludes weeks that have not gone final', async () => {
      await queries.upsertMatchup({
        leagueId, week: 3, matchupId: 1,
        rosterA: 1, rosterB: 2, pointsA: 10, pointsB: 5, status: 'live',
      });
      const history = await queries.seasonHistory(leagueId, 3);
      expect(history.weeks.some((w) => w.week === 3)).toBe(false);
    });

    it('carries a bye through as a null opponent', async () => {
      await queries.upsertMatchup({
        leagueId, week: 4, matchupId: 2,
        rosterA: 1, rosterB: null, pointsA: 95, pointsB: 0, status: 'final',
      });
      const history = await queries.seasonHistory(leagueId, 4);
      const bye = history.weeks.find((w) => w.week === 4);
      expect(bye?.opponentRosterId).toBeNull();
      expect(bye?.opponentScore).toBeNull();
    });
  });

  describe('odds snapshots', () => {
    it('persists a tick and reads it back keyed by Sleeper matchup id', async () => {
      const row = await queries.upsertMatchup({
        leagueId, week: 5, matchupId: 7,
        rosterA: 1, rosterB: 2, pointsA: 0, pointsB: 0, status: 'live',
      });

      await queries.insertOddsSnapshot({
        matchupRowId: row.id,
        snapshot: {
          capturedAt: new Date('2026-10-18T17:00:00Z').toISOString(),
          phase: 'open',
          winProbA: 0.58, spread: 4.5, total: 220,
          moneylineA: -138, moneylineB: 138,
          meanA: 112, meanB: 108, sdA: 20, sdB: 19,
          detail: { scoreA: 0, scoreB: 0, playerPoints: { p1: 0 } },
        },
      });

      const byMatchup = await queries.oddsByMatchup(leagueId, 5);
      expect(byMatchup[7]).toHaveLength(1);
      expect(byMatchup[7]?.[0]?.winProbA).toBe(0.58);
      expect(byMatchup[7]?.[0]?.detail?.playerPoints).toEqual({ p1: 0 });
    });

    it('returns ticks in capture order', async () => {
      const row = await queries.upsertMatchup({
        leagueId, week: 5, matchupId: 7,
        rosterA: 1, rosterB: 2, pointsA: 50, pointsB: 40, status: 'live',
      });
      for (const [minute, prob] of [[120, 0.94], [60, 0.72]] as const) {
        await queries.insertOddsSnapshot({
          matchupRowId: row.id,
          snapshot: {
            capturedAt: new Date(Date.UTC(2026, 9, 18, 17, minute)).toISOString(),
            phase: 'live',
            winProbA: prob, spread: 4, total: 220,
            moneylineA: -138, moneylineB: 138,
            meanA: 112, meanB: 108, sdA: 20, sdB: 19,
          },
        });
      }

      const ticks = (await queries.oddsByMatchup(leagueId, 5))[7] ?? [];
      const times = ticks.map((t) => new Date(t.capturedAt).getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    });
  });

  describe('stat packets', () => {
    const packet = {
      leagueId: 'x', leagueName: 'The League', season: '2026', week: 1,
      computedAt: new Date().toISOString(),
      teams: [], matchups: [], awards: [],
      transactions: { adds: [], drops: [], trades: [], waiverRoi: [] },
      hotPlayers: [], teamOfTheWeek: null, upcoming: [], storylinesLive: [],
    };

    it('round-trips a packet through jsonb', async () => {
      await queries.saveStatPacket(leagueId, 1, packet as never);
      const read = await queries.getStatPacket(leagueId, 1);
      expect(read?.leagueName).toBe('The League');
      expect(read?.week).toBe(1);
    });

    it('overwrites on re-computation rather than duplicating', async () => {
      await queries.saveStatPacket(leagueId, 1, { ...packet, leagueName: 'Renamed' } as never);
      const all = await queries.listStatPackets(leagueId);
      expect(all.filter((p) => p.week === 1)).toHaveLength(1);
      expect(all.find((p) => p.week === 1)?.packet.leagueName).toBe('Renamed');
    });

    it('reports the latest week', async () => {
      await queries.saveStatPacket(leagueId, 4, { ...packet, week: 4 } as never);
      expect(await queries.latestPacketWeek(leagueId)).toBe(4);
    });
  });

  describe('awards', () => {
    it('stores awards against manager ids', async () => {
      const managers = await queries.listManagers(leagueId);
      const byName: Record<string, string> = {};
      for (const manager of managers) byName[manager.display_name] = manager.id;

      await queries.saveAwards(
        leagueId, 1,
        [{
          key: 'shit_the_bed', label: 'Sh*t the Bed', manager: 'Dave',
          managerId: byName.Dave as string, value: 48.3,
          evidence: { score: 48.3, leagueMean: 90 },
        }],
        byName,
      );

      const rows = await db.query<{ award_key: string; value: string }>(
        'SELECT award_key, value FROM awards WHERE league_id = $1 AND week = 1',
        [leagueId],
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]?.value)).toBe(48.3);
    });
  });

  describe('storylines', () => {
    it('saves and reads threads with their lifecycle state', async () => {
      await queries.saveStorylines(leagueId, '2026', [
        {
          threadKey: 'dave_bench_curse',
          summary: 'Dave keeps benching his best tight end.',
          sinceWeek: 1, lastReferencedWeek: 3,
          status: 'live', managerIds: ['m1'],
        },
      ]);

      const threads = await queries.listStorylines(leagueId, '2026');
      expect(threads).toHaveLength(1);
      expect(threads[0]).toMatchObject({
        threadKey: 'dave_bench_curse', status: 'live', sinceWeek: 1, lastReferencedWeek: 3,
      });
    });

    it('updates an existing thread in place', async () => {
      await queries.saveStorylines(leagueId, '2026', [
        {
          threadKey: 'dave_bench_curse', summary: 'Resolved at last.',
          sinceWeek: 1, lastReferencedWeek: 5, status: 'resolved', managerIds: ['m1'],
        },
      ]);
      const threads = await queries.listStorylines(leagueId, '2026');
      expect(threads).toHaveLength(1);
      expect(threads[0]?.status).toBe('resolved');
    });
  });

  describe('reports', () => {
    it('saves and reads a generated report', async () => {
      await queries.saveReport({
        leagueId, week: 1, kind: 'commissioner', variant: '',
        body: '## Cold open\n\nDave scored 93.5.',
        factCheckStatus: { sentences: 1, cutSentences: 0, failureRate: 0 },
      });

      const report = await queries.getReport(leagueId, 1, 'commissioner');
      expect(report?.body).toContain('93.5');
      expect(report?.fact_check_status).toMatchObject({ failureRate: 0 });
    });

    it('replaces on regeneration', async () => {
      await queries.saveReport({
        leagueId, week: 1, kind: 'commissioner', variant: '',
        body: 'Regenerated.', factCheckStatus: {},
      });
      const report = await queries.getReport(leagueId, 1, 'commissioner');
      expect(report?.body).toBe('Regenerated.');
    });
  });

  describe('projections', () => {
    it('round-trips and reads back the latest source', async () => {
      await queries.upsertProjections('2026', 1, 'consensus', [
        { playerId: 'p1', mean: 14.2, sd: 6 },
        { playerId: 'p2', mean: 9.8, sd: null },
      ]);
      const projections = await queries.weekProjections('2026', 1, 'consensus');
      expect(projections.p1).toBe(14.2);
      expect(projections.p2).toBe(9.8);
    });

    it('overwrites the same source rather than accumulating', async () => {
      await queries.upsertProjections('2026', 1, 'consensus', [{ playerId: 'p1', mean: 20 }]);
      const projections = await queries.weekProjections('2026', 1, 'consensus');
      expect(projections.p1).toBe(20);
    });
  });

  describe('cascade', () => {
    it('removes every dependent row when a league is deleted', async () => {
      await db.query('DELETE FROM leagues WHERE id = $1', [leagueId]);

      for (const table of ['managers', 'rosters', 'matchups', 'stat_packets', 'awards', 'storylines', 'reports']) {
        const rows = await db.query<{ count: string }>(
          `SELECT count(*) FROM ${table} WHERE league_id = $1`,
          [leagueId],
        );
        expect(Number(rows[0]?.count), `${table} should be empty`).toBe(0);
      }

      // odds_snapshots hangs off matchups, not leagues — check it went too.
      const orphans = await db.query<{ count: string }>(
        `SELECT count(*) FROM odds_snapshots o
         LEFT JOIN matchups m ON m.id = o.matchup_id WHERE m.id IS NULL`,
      );
      expect(Number(orphans[0]?.count)).toBe(0);
    });
  });
});
