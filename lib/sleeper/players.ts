import 'server-only';

import { cache, cacheKeys } from '@/lib/cache/redis';
import { sleeper } from './client';
import type { PlayerLite, SleeperPlayer } from './types';

/**
 * The player dictionary boundary.
 *
 * `/players/nfl` is roughly 10MB of JSON and Sleeper asks that it be fetched at
 * most once per day. Everything in this module runs server-side: the daily cron
 * fetches the raw dictionary, reduces it to the five fields anything downstream
 * actually reads, and writes the reduced map to Redis. No caller outside this
 * file should ever see the raw shape, and the reduced map must not be handed to
 * a client component wholesale either — look players up by id instead.
 */

const DICTIONARY_TTL_SECONDS = 60 * 60 * 36; // 36h: survives one missed cron run.

/** Positions we keep. Sleeper ships every practice-squad body in the league. */
const KEPT_POSITIONS = new Set([
  'QB', 'RB', 'WR', 'TE', 'K', 'DEF',
  'DL', 'LB', 'DB', 'IDP_FLEX', 'DE', 'DT', 'CB', 'S', 'OL',
]);

export function reducePlayer(id: string, raw: SleeperPlayer): PlayerLite | null {
  const position = raw.position ?? raw.fantasy_positions?.[0] ?? null;
  if (!position || !KEPT_POSITIONS.has(position)) return null;

  const name =
    raw.full_name ??
    [raw.first_name, raw.last_name].filter(Boolean).join(' ').trim() ??
    '';
  if (!name) return null;

  // Sleeper sends bye_week as a number, a string, or not at all.
  const bye = raw.bye_week === null || raw.bye_week === undefined ? null : Number(raw.bye_week);

  return {
    id,
    name,
    position,
    team: raw.team ?? null,
    injury_status: raw.injury_status ?? null,
    bye_week: Number.isFinite(bye) && (bye as number) > 0 ? (bye as number) : null,
  };
}

export function reduceDictionary(raw: Record<string, SleeperPlayer>): Record<string, PlayerLite> {
  const out: Record<string, PlayerLite> = {};
  for (const [id, player] of Object.entries(raw)) {
    const lite = reducePlayer(id, player);
    if (lite) out[id] = lite;
  }
  return out;
}

/**
 * Called by the daily cron only. Returns the number of players kept so the job
 * can log a size the next run can be compared against — a sudden drop means
 * Sleeper changed the shape and the reducer is silently dropping everyone.
 */
export async function refreshPlayerDictionary(): Promise<{ kept: number; total: number }> {
  const raw = await sleeper.playersRaw('nfl');
  if (!raw) throw new Error('Sleeper returned an empty player dictionary');

  const lite = reduceDictionary(raw);
  const kept = Object.keys(lite).length;
  if (kept < 500) {
    throw new Error(`Player dictionary reduced to ${kept} players — refusing to overwrite the cache`);
  }

  const store = cache();
  await store.set(cacheKeys.playerDictionary, lite, DICTIONARY_TTL_SECONDS);
  await store.set(cacheKeys.playerDictionaryStamp, new Date().toISOString(), DICTIONARY_TTL_SECONDS);
  return { kept, total: Object.keys(raw).length };
}

let inProcess: Record<string, PlayerLite> | null = null;

/**
 * Reads the reduced dictionary. Falls through to a live refresh if the cache is
 * cold, which should only happen on a first deploy or after a 36h cron outage.
 */
export async function playerDictionary(): Promise<Record<string, PlayerLite>> {
  if (inProcess) return inProcess;

  const store = cache();
  const hit = await store.get<Record<string, PlayerLite>>(cacheKeys.playerDictionary);
  if (hit) {
    inProcess = hit;
    return hit;
  }

  await refreshPlayerDictionary();
  const warmed = await store.get<Record<string, PlayerLite>>(cacheKeys.playerDictionary);
  inProcess = warmed ?? {};
  return inProcess;
}

/** Resolve a set of ids to display records. This is the client-safe path. */
export async function resolvePlayers(ids: Iterable<string>): Promise<Record<string, PlayerLite>> {
  const dict = await playerDictionary();
  const out: Record<string, PlayerLite> = {};
  for (const id of ids) {
    const player = dict[id];
    if (player) out[id] = player;
    else out[id] = { id, name: id, position: 'UNK', team: null, injury_status: null, bye_week: null };
  }
  return out;
}

export function __resetPlayerDictionaryForTests(): void {
  inProcess = null;
}
