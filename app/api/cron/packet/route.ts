import { NextResponse } from 'next/server';
import { authorizeCron } from '@/lib/auth';
import { getLeague, listLeagues } from '@/lib/db/queries';
import { currentState } from '@/lib/jobs/ingest';
import { buildAndStorePacket } from '@/lib/jobs/packet';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Weekly stat packet computation.
 *
 * Scheduled for after the last game of the week goes final (Tuesday morning ET
 * is the safe slot — it clears Monday night and any Tuesday stat corrections).
 * Accepts leagueId and week overrides so a packet can be rebuilt by hand after
 * a correction lands.
 */
export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}

async function run(request: Request) {
  const denied = authorizeCron(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const onlyLeagueId = url.searchParams.get('leagueId');
  const weekParam = url.searchParams.get('week');

  let week: number;
  try {
    // The packet is for the week that just finished, not the one now open.
    week = weekParam ? Number(weekParam) : Math.max(1, (await currentState()).week - 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not read NFL state.';
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }

  const leagues = onlyLeagueId
    ? [await getLeague(onlyLeagueId)].filter((league) => league !== null)
    : await listLeagues();

  const results: { leagueId: string; week: number; teams?: number; error?: string }[] = [];

  for (const league of leagues) {
    try {
      const packet = await buildAndStorePacket(league, week, { status: 'final' });
      results.push({ leagueId: league.id, week, teams: packet.teams.length });
    } catch (error) {
      results.push({
        leagueId: league.id,
        week,
        error: error instanceof Error ? error.message : 'packet failed',
      });
    }
  }

  return NextResponse.json({ ok: true, week, results });
}
