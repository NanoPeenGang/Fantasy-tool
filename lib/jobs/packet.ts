import 'server-only';

import { buildStatPacket } from '@/lib/compute/packet';
import { seasonAwardCounts } from '@/lib/compute/awards';
import type { StatPacket, Storyline, UpcomingMatchup } from '@/lib/compute/types';
import {
  listManagers,
  listStatPackets,
  listStorylines,
  oddsByMatchup,
  saveAwards,
  saveStatPacket,
  seasonHistory,
  weekProjections,
  type LeagueRow,
} from '@/lib/db/queries';
import { fetchTransactions, fetchWeek } from './ingest';

/**
 * Compute and persist the weekly stat packet — the canonical artifact.
 *
 * Runs once when the last game of the week goes final. Everything downstream
 * (dashboard, odds board, AAR, recap) reads the stored packet and recomputes
 * nothing, which is what keeps four surfaces agreeing about what happened.
 */

export type BuildPacketOptions = {
  /** Recompute and overwrite an existing packet for the week. */
  force?: boolean;
  status?: 'live' | 'final';
};

export async function buildAndStorePacket(
  league: LeagueRow,
  week: number,
  options: BuildPacketOptions = {},
): Promise<StatPacket> {
  const snapshot = await fetchWeek(league, week, {
    persist: true,
    status: options.status ?? 'final',
  });

  const [history, odds, managers, priorPackets, storylines, projections, transactions] =
    await Promise.all([
      seasonHistory(league.id, week),
      oddsByMatchup(league.id, week),
      listManagers(league.id),
      listStatPackets(league.id),
      listStorylines(league.id, league.season),
      weekProjections(league.season, week),
      fetchTransactions(league, week),
    ]);

  // Last week's ranks drive the movement arrows.
  const previousPacket = priorPackets.filter((p) => p.week < week).sort((a, b) => b.week - a.week)[0];
  const previousPowerRanks: Record<string, number> = {};
  for (const team of previousPacket?.packet.teams ?? []) {
    previousPowerRanks[team.managerId] = team.powerRank;
  }

  const managerByRoster: Record<number, string> = {};
  for (const matchup of snapshot.matchups) {
    managerByRoster[matchup.a.rosterId] = matchup.a.manager;
    if (matchup.b) managerByRoster[matchup.b.rosterId] = matchup.b.manager;
  }

  const playerNames: Record<string, string> = {};
  for (const [id, player] of Object.entries(snapshot.players)) playerNames[id] = player.name;

  // Weekly points per player, for waiver ROI from the acquisition forward.
  const pointsByWeek: Record<number, Record<string, number>> = {};
  for (const { week: priorWeek, packet } of priorPackets) {
    const bucket: Record<string, number> = {};
    for (const hot of packet.hotPlayers) bucket[hot.playerId] = hot.points;
    pointsByWeek[priorWeek] = bucket;
  }
  pointsByWeek[week] = Object.fromEntries(
    snapshot.matchups.flatMap((m) => [
      ...Object.entries(m.a.points),
      ...(m.b ? Object.entries(m.b.points) : []),
    ]),
  );

  const packet = buildStatPacket({
    leagueId: league.id,
    leagueName: league.name,
    season: league.season,
    week,
    rosterPositions: league.roster_positions,
    matchups: snapshot.matchups,
    players: snapshot.players,
    history,
    oddsByMatchup: odds,
    projections,
    previousPowerRanks,
    storylines,
    upcoming: await upcomingMatchups(league, week),
    transactions: {
      transactions,
      points: { byWeek: pointsByWeek },
      managerByRoster,
      playerNames,
      throughWeek: week,
    },
  });

  await saveStatPacket(league.id, week, packet);

  const managerIdByName: Record<string, string> = {};
  for (const manager of managers) managerIdByName[manager.display_name] = manager.id;
  await saveAwards(league.id, week, packet.awards, managerIdByName);

  return packet;
}

/**
 * Next week's card. Opening lines need a projection source, so until one is
 * configured this returns the pairings with a null line rather than inventing
 * one — the recap's "next week" section degrades to a fixture list.
 */
async function upcomingMatchups(league: LeagueRow, week: number): Promise<UpcomingMatchup[]> {
  try {
    const next = await fetchWeek(league, week + 1);
    return next.matchups
      .filter((matchup) => matchup.b !== null)
      .map((matchup) => ({
        a: matchup.a.manager,
        b: (matchup.b as { manager: string }).manager,
        openingLine: null,
        storylineHook: null,
      }));
  } catch {
    // The schedule for a week that does not exist yet is not an error worth
    // failing the packet over.
    return [];
  }
}

/** Running award counts across the season, for the recap's awards section. */
export async function awardCountsThrough(league: LeagueRow, week: number) {
  const packets = await listStatPackets(league.id);
  return seasonAwardCounts(
    packets.filter((p) => p.week <= week).map((p) => ({ week: p.week, awards: p.packet.awards })),
  );
}

export async function liveStorylines(league: LeagueRow): Promise<Storyline[]> {
  return (await listStorylines(league.id, league.season)).filter((s) => s.status === 'live');
}
