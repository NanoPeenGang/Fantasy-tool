import 'server-only';

import { Redis } from '@upstash/redis';

/**
 * Cache facade over Upstash. When Upstash is not configured we fall back to an
 * in-process map so local dev and tests work — that fallback is per-instance and
 * therefore wrong for serverless, which is why anything durable (stat packets,
 * odds snapshots) goes to Postgres and only derived/refetchable state lives here.
 */
export interface CacheStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
}

class MemoryCache implements CacheStore {
  private readonly store = new Map<string, { value: unknown; expiresAt: number | null }>();

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}

class UpstashCache implements CacheStore {
  constructor(private readonly redis: Redis) {}

  async get<T>(key: string): Promise<T | null> {
    return (await this.redis.get<T>(key)) ?? null;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) await this.redis.set(key, value, { ex: ttlSeconds });
    else await this.redis.set(key, value);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

let cached: CacheStore | null = null;

export function cache(): CacheStore {
  if (cached) return cached;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  cached = url && token ? new UpstashCache(new Redis({ url, token })) : new MemoryCache();
  return cached;
}

export const cacheKeys = {
  playerDictionary: 'players:nfl:lite:v1',
  playerDictionaryStamp: 'players:nfl:lite:v1:updated_at',
  nflState: 'state:nfl',
  leagueMatchups: (leagueId: string, week: number) => `matchups:${leagueId}:${week}`,
  leagueBundle: (leagueId: string) => `league:${leagueId}:bundle`,
  draftPicks: (draftId: string) => `draft:${draftId}:picks`,
} as const;

/** Test seam: lets suites inject a store without touching Upstash. */
export function __setCacheForTests(store: CacheStore | null): void {
  cached = store;
}
