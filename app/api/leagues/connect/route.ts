import { NextResponse } from 'next/server';
import { z } from 'zod';
import { connectLeague } from '@/lib/jobs/ingest';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const Body = z.object({
  sleeperLeagueId: z.string().regex(/^\d{5,25}$/, 'That does not look like a Sleeper league ID.'),
  ownerUserId: z.string().optional(),
});

export async function POST(request: Request) {
  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await request.json());
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues[0]?.message ?? 'Invalid request.'
        : 'Invalid request.';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const result = await connectLeague(parsed.sleeperLeagueId, parsed.ownerUserId ?? null);
    return NextResponse.json({
      leagueId: result.league.id,
      name: result.league.name,
      season: result.league.season,
      managers: result.managers.length,
      rosters: result.rosterCount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not connect that league.';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
