import { NextResponse } from 'next/server';
import { authorizeCron } from '@/lib/auth';
import { listLeagues } from '@/lib/db/queries';
import { connectLeague } from '@/lib/jobs/ingest';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Daily league metadata refresh: scoring settings, roster positions, users and
 * rosters. `connectLeague` is idempotent, so the connect flow and this job are
 * the same code path.
 */
export async function GET(request: Request) {
  const denied = authorizeCron(request);
  if (denied) return denied;

  const leagues = await listLeagues();
  const results: { leagueId: string; ok: boolean; error?: string }[] = [];

  for (const league of leagues) {
    try {
      await connectLeague(league.sleeper_league_id, league.owner_user_id);
      results.push({ leagueId: league.id, ok: true });
    } catch (error) {
      results.push({
        leagueId: league.id,
        ok: false,
        error: error instanceof Error ? error.message : 'refresh failed',
      });
    }
  }

  return NextResponse.json({ ok: true, leagues: results.length, results });
}
