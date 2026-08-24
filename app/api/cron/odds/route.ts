import { NextResponse } from 'next/server';
import { authorizeCron } from '@/lib/auth';
import { getLeague, listLeagues } from '@/lib/db/queries';
import { currentState } from '@/lib/jobs/ingest';
import { tickOdds } from '@/lib/jobs/odds';
import { FUNCTION_BUDGET_MS, TimeBudget } from '@/lib/jobs/budget';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The live odds tick.
 *
 * Designed for a 60-second cadence. Vercel's Hobby plan will not run a cron
 * more often than daily, so there the tick is driven by
 * .github/workflows/odds-tick.yml at GitHub's 5-minute floor instead — a
 * coarser curve, but a curve.
 *
 * Fans out across every connected league from one call. Each league costs one
 * Sleeper request per tick, which keeps a few thousand leagues comfortably
 * inside Sleeper's 1000/min ceiling — provided this stays a shared poller and
 * does not become one poller per user session.
 *
 * A league that fails is logged and skipped: one bad league must not stop the
 * others from getting a tick, because a gap in the curve is a gap in the swing
 * chart forever.
 */
export async function GET(request: Request) {
  const denied = authorizeCron(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const onlyLeagueId = url.searchParams.get('leagueId');
  const weekParam = url.searchParams.get('week');

  let week: number;
  try {
    week = weekParam ? Number(weekParam) : (await currentState()).week;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not read NFL state.';
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }

  const leagues = onlyLeagueId
    ? [await getLeague(onlyLeagueId)].filter((league) => league !== null)
    : await listLeagues();

  const results: { leagueId: string; matchups?: number; complete?: boolean; error?: string }[] = [];
  const budget = new TimeBudget(FUNCTION_BUDGET_MS);
  let skipped = 0;

  for (const league of leagues) {
    // A tick that gets killed mid-fan-out loses every league after the one it
    // was on, and leaves no record of where it stopped. Stopping short keeps
    // the leagues already ticked and names the shortfall.
    if (budget.exhausted()) {
      skipped = leagues.length - results.length;
      break;
    }
    try {
      const tick = await tickOdds(league, week);
      results.push({
        leagueId: league.id,
        matchups: tick.matchups,
        complete: tick.weekComplete,
      });
    } catch (error) {
      results.push({
        leagueId: league.id,
        error: error instanceof Error ? error.message : 'tick failed',
      });
    }
  }

  return NextResponse.json({
    ok: true,
    week,
    leagues: results.length,
    skipped,
    elapsedMs: budget.elapsedMs(),
    results,
  });
}
