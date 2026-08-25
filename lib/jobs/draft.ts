import 'server-only';

import { sleeper } from '@/lib/sleeper/client';
import { playerDictionary } from '@/lib/sleeper/players';
import { mineTendencies, type HistoricalPick } from '@/lib/warroom/tendencies';
import {
  listDraftPicks,
  listManagers,
  saveTendencies,
  upsertDraftPicks,
  type LeagueRow,
} from '@/lib/db/queries';

/**
 * Draft history import.
 *
 * Chains back through `previous_league_id` to pull every draft this room has
 * ever run. That chain is the war room's whole edge: the players change every
 * year, but the fact that this league lets tight ends fall to round nine, and
 * that Dave always reaches for a quarterback, does not.
 */

export type ImportResult = {
  seasons: string[];
  drafts: number;
  picks: number;
  tendencies: number;
  /** Leagues visited but skipped, with why. */
  skipped: { leagueId: string; reason: string }[];
};

/** How far back to chain. Two prior seasons make tendency mining work; more is better. */
const MAX_CHAIN_DEPTH = 6;

export async function importDraftHistory(
  league: LeagueRow,
  options: { maxSeasons?: number } = {},
): Promise<ImportResult> {
  const depth = options.maxSeasons ?? MAX_CHAIN_DEPTH;
  const dictionary = await playerDictionary();

  const result: ImportResult = {
    seasons: [], drafts: 0, picks: 0, tendencies: 0, skipped: [],
  };

  let sleeperLeagueId: string | null = league.sleeper_league_id;
  const visited = new Set<string>();

  for (let i = 0; i < depth && sleeperLeagueId; i += 1) {
    // A malformed previous_league_id chain can loop; a season imported twice is
    // harmless but an infinite walk is not.
    if (visited.has(sleeperLeagueId)) break;
    visited.add(sleeperLeagueId);

    const drafts = await sleeper.drafts(sleeperLeagueId);
    if (!drafts || drafts.length === 0) {
      result.skipped.push({ leagueId: sleeperLeagueId, reason: 'no drafts' });
    } else {
      for (const draft of drafts) {
        const picks = await sleeper.draftPicks(draft.draft_id);
        if (!picks || picks.length === 0) {
          result.skipped.push({ leagueId: sleeperLeagueId, reason: `draft ${draft.draft_id} has no picks` });
          continue;
        }

        const rows = picks
          .filter((pick) => pick.player_id)
          .map((pick) => {
            const player = dictionary[pick.player_id];
            return {
              draftId: draft.draft_id,
              season: draft.season,
              pickNo: pick.pick_no,
              round: pick.round,
              playerId: pick.player_id,
              // Fall back to the pick's own metadata: a player who has since
              // retired is gone from the dictionary but still in the history.
              position: player?.position ?? pick.metadata?.position ?? 'UNK',
              nflTeam: player?.team ?? pick.metadata?.team ?? null,
              pickedBy: pick.picked_by || null,
              rosterId: pick.roster_id ?? null,
            };
          });

        result.picks += await upsertDraftPicks(league.id, rows);
        result.drafts += 1;
        if (!result.seasons.includes(draft.season)) result.seasons.push(draft.season);
      }
    }

    const previous: { previous_league_id: string | null } | null =
      await sleeper.league(sleeperLeagueId);
    sleeperLeagueId = previous?.previous_league_id ?? null;
  }

  result.tendencies = await recomputeTendencies(league);
  result.seasons.sort();
  return result;
}

/**
 * Recompute and store tendencies from whatever draft history is on hand.
 *
 * Picks are stored by Sleeper user id rather than by our manager row, so a
 * manager who left and came back keeps their history. Mapping happens here.
 */
export async function recomputeTendencies(league: LeagueRow): Promise<number> {
  const [picks, managers] = await Promise.all([
    listDraftPicks(league.id),
    listManagers(league.id),
  ]);

  const managerBySleeperId = new Map(managers.map((m) => [m.sleeper_user_id, m.id]));

  const historical: HistoricalPick[] = picks
    .filter((pick) => pick.picked_by && managerBySleeperId.has(pick.picked_by))
    .map((pick) => ({
      season: pick.season,
      draftId: pick.draft_id,
      managerId: managerBySleeperId.get(pick.picked_by as string) as string,
      playerId: pick.player_id,
      position: pick.position,
      nflTeam: pick.nfl_team,
      round: pick.round,
      pickNo: pick.pick_no,
      adp: null,
    }));

  if (historical.length === 0) return 0;

  const tendencies = mineTendencies(historical);
  await saveTendencies(league.id, tendencies);
  return tendencies.length;
}

/** Historical picks in the shape the war room's compute layer expects. */
export async function historicalPicks(league: LeagueRow): Promise<HistoricalPick[]> {
  const [picks, managers] = await Promise.all([
    listDraftPicks(league.id),
    listManagers(league.id),
  ]);
  const managerBySleeperId = new Map(managers.map((m) => [m.sleeper_user_id, m.id]));

  return picks.map((pick) => ({
    season: pick.season,
    draftId: pick.draft_id,
    managerId: pick.picked_by ? managerBySleeperId.get(pick.picked_by) ?? pick.picked_by : 'unknown',
    playerId: pick.player_id,
    position: pick.position,
    nflTeam: pick.nfl_team,
    round: pick.round,
    pickNo: pick.pick_no,
    adp: null,
  }));
}

/**
 * The live draft: who has been taken, by whom, and in what order.
 *
 * Polled every five seconds while a draft is running, which is the one place in
 * this app where Sleeper's rate limit is a real consideration — hence one fetch
 * per draft, shared, rather than one per viewer.
 */
export async function liveDraftState(league: LeagueRow): Promise<{
  draftId: string | null;
  status: string | null;
  taken: Record<string, { by: string; pick: number }>;
  recentPositions: string[];
  pickCount: number;
} | null> {
  const drafts = await sleeper.drafts(league.sleeper_league_id);
  const draft = drafts?.[0];
  if (!draft) return null;

  const [picks, managers, dictionary] = await Promise.all([
    sleeper.draftPicks(draft.draft_id),
    listManagers(league.id),
    playerDictionary(),
  ]);

  const nameBySleeperId = new Map(managers.map((m) => [m.sleeper_user_id, m.display_name]));
  const taken: Record<string, { by: string; pick: number }> = {};
  const ordered = [...(picks ?? [])].sort((a, b) => a.pick_no - b.pick_no);

  for (const pick of ordered) {
    if (!pick.player_id) continue;
    taken[pick.player_id] = {
      by: nameBySleeperId.get(pick.picked_by) ?? `Roster ${pick.roster_id ?? '?'}`,
      pick: pick.pick_no,
    };
  }

  return {
    draftId: draft.draft_id,
    status: draft.status,
    taken,
    // Most recent last, which is what the run detector's window expects.
    recentPositions: ordered
      .slice(-10)
      .map((pick) => dictionary[pick.player_id]?.position ?? pick.metadata?.position ?? 'UNK'),
    pickCount: ordered.length,
  };
}
