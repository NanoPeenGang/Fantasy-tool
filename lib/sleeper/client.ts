import 'server-only';

import type {
  SleeperDraft,
  SleeperDraftPick,
  SleeperLeague,
  SleeperMatchup,
  SleeperPlayer,
  SleeperRoster,
  SleeperState,
  SleeperTransaction,
  SleeperTrendingPlayer,
  SleeperUser,
} from './types';

const BASE = 'https://api.sleeper.app/v1';

/**
 * Sleeper asks callers to stay under 1000 requests/minute globally. This limiter
 * is per-process, so on a serverless platform it bounds a single instance rather
 * than the fleet — the real protection is that ingestion fans out from one
 * cached fetch per league (see lib/jobs/), not per user session. The budget is
 * deliberately set well below Sleeper's ceiling to leave room for concurrency.
 */
const RATE_LIMIT_PER_MINUTE = Number(process.env.SLEEPER_RATE_LIMIT ?? 600);

class RateLimiter {
  private timestamps: number[] = [];

  constructor(private readonly limit: number, private readonly windowMs = 60_000) {}

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
      if (this.timestamps.length < this.limit) {
        this.timestamps.push(now);
        return;
      }
      const oldest = this.timestamps[0] ?? now;
      const waitMs = Math.max(10, this.windowMs - (now - oldest));
      await sleep(waitMs);
    }
  }
}

const limiter = new RateLimiter(RATE_LIMIT_PER_MINUTE);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SleeperError extends Error {
  constructor(readonly status: number, readonly path: string, message: string) {
    super(message);
    this.name = 'SleeperError';
  }
}

/**
 * Next.js extends RequestInit with its own `next` field. Declaring it here keeps
 * `tsc --noEmit` working without depending on the generated next-env.d.ts.
 */
type NextRequestInit = RequestInit & {
  next?: { revalidate?: number | false; tags?: string[] };
};

export type FetchOptions = {
  /** Seconds Next.js may reuse a cached response. 0 disables caching. */
  revalidate?: number;
  retries?: number;
  signal?: AbortSignal;
};

/**
 * A 404 from Sleeper means "no such object" and a `null` body means "nothing for
 * this week" — both are normal, so they resolve to null rather than throwing.
 * 429 and 5xx are retried with exponential backoff plus jitter.
 */
async function get<T>(path: string, options: FetchOptions = {}): Promise<T | null> {
  const { revalidate = 0, retries = 3, signal } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await limiter.take();
    try {
      const init: NextRequestInit = {
        signal,
        headers: { accept: 'application/json' },
        next: revalidate > 0 ? { revalidate } : undefined,
        cache: revalidate > 0 ? undefined : 'no-store',
      };
      const response = await fetch(`${BASE}${path}`, init);

      if (response.status === 404) return null;

      if (response.status === 429 || response.status >= 500) {
        lastError = new SleeperError(response.status, path, `Sleeper returned ${response.status}`);
        if (attempt < retries) {
          await sleep(backoffMs(attempt, response.headers.get('retry-after')));
          continue;
        }
        throw lastError;
      }

      if (!response.ok) {
        throw new SleeperError(response.status, path, `Sleeper returned ${response.status}`);
      }

      const body = (await response.json()) as T | null;
      return body ?? null;
    } catch (error) {
      if (error instanceof SleeperError && error.status < 500 && error.status !== 429) throw error;
      if (signal?.aborted) throw error;
      lastError = error;
      if (attempt < retries) {
        await sleep(backoffMs(attempt, null));
        continue;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new SleeperError(0, path, 'Sleeper request failed for an unknown reason');
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 30_000);
  }
  const base = Math.min(2 ** attempt * 500, 8_000);
  return base + Math.random() * 250;
}

export const sleeper = {
  /** Source of truth for the current week and season phase. Polled every 15 min. */
  state: (sport = 'nfl') => get<SleeperState>(`/state/${sport}`, { revalidate: 300 }),

  league: (leagueId: string) => get<SleeperLeague>(`/league/${leagueId}`, { revalidate: 3600 }),

  users: (leagueId: string) => get<SleeperUser[]>(`/league/${leagueId}/users`, { revalidate: 3600 }),

  rosters: (leagueId: string) => get<SleeperRoster[]>(`/league/${leagueId}/rosters`, { revalidate: 300 }),

  /** Polled every 60s during game windows — never cached. */
  matchups: (leagueId: string, week: number) =>
    get<SleeperMatchup[]>(`/league/${leagueId}/matchups/${week}`, { revalidate: 0 }),

  transactions: (leagueId: string, week: number) =>
    get<SleeperTransaction[]>(`/league/${leagueId}/transactions/${week}`, { revalidate: 600 }),

  drafts: (leagueId: string) => get<SleeperDraft[]>(`/league/${leagueId}/drafts`, { revalidate: 3600 }),

  draft: (draftId: string) => get<SleeperDraft>(`/draft/${draftId}`, { revalidate: 60 }),

  /** Polled every 5s during an active draft. */
  draftPicks: (draftId: string) => get<SleeperDraftPick[]>(`/draft/${draftId}/picks`, { revalidate: 0 }),

  trendingAdds: (sport = 'nfl', hours = 24, limit = 25) =>
    get<SleeperTrendingPlayer[]>(`/players/${sport}/trending/add?lookback_hours=${hours}&limit=${limit}`, {
      revalidate: 3600,
    }),

  /**
   * ~10MB. Sleeper asks that this be called at most once per day, and it must
   * never reach a browser. Only lib/sleeper/players.ts should call it, from the
   * daily cron; everything else reads the reduced dictionary out of Redis.
   */
  playersRaw: (sport = 'nfl') =>
    get<Record<string, SleeperPlayer>>(`/players/${sport}`, { revalidate: 0, retries: 2 }),
};

export type SleeperClient = typeof sleeper;
