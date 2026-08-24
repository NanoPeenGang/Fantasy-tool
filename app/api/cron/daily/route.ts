import { NextResponse } from 'next/server';
import { authorizeCron } from '@/lib/auth';
import { listLeagues } from '@/lib/db/queries';
import { connectLeague } from '@/lib/jobs/ingest';
import { refreshPlayerDictionary } from '@/lib/sleeper/players';
import { FUNCTION_BUDGET_MS, TimeBudget } from '@/lib/jobs/budget';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The consolidated daily job: player dictionary, then league metadata.
 *
 * These are two separate concerns and they have their own routes
 * (/api/cron/players and /api/cron/leagues) for manual and external triggering.
 * They share one cron entry because Vercel's Hobby plan allows only two cron
 * jobs per project, and spending both on daily refreshes would leave none for
 * the weekly packet.
 *
 * Order matters: the dictionary is refreshed first because the league refresh
 * and everything downstream resolve players through it.
 */
export async function GET(request: Request) {
  const denied = authorizeCron(request);
  if (denied) return denied;

  const budget = new TimeBudget(FUNCTION_BUDGET_MS);
  const result: {
    players?: { kept: number; total: number } | { error: string };
    leagues: { leagueId: string; ok: boolean; error?: string }[];
    skipped: number;
    elapsedMs?: number;
  } = { leagues: [], skipped: 0 };

  try {
    result.players = await refreshPlayerDictionary();
  } catch (error) {
    // A stale dictionary is survivable — the cache holds for 36 hours, which is
    // one missed run. League refresh is still worth attempting.
    result.players = { error: error instanceof Error ? error.message : 'refresh failed' };
  }

  const leagues = await listLeagues();
  for (const league of leagues) {
    if (budget.exhausted()) {
      result.skipped = leagues.length - result.leagues.length;
      break;
    }
    try {
      await connectLeague(league.sleeper_league_id, league.owner_user_id);
      result.leagues.push({ leagueId: league.id, ok: true });
    } catch (error) {
      result.leagues.push({
        leagueId: league.id,
        ok: false,
        error: error instanceof Error ? error.message : 'refresh failed',
      });
    }
  }

  result.elapsedMs = budget.elapsedMs();
  return NextResponse.json({ ok: true, ...result });
}
