import { NextResponse } from 'next/server';
import { z } from 'zod';
import { connectLeague } from '@/lib/jobs/ingest';
import { databaseStatus } from '@/lib/db/client';

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

  // Check setup before calling Sleeper. Without this the first failure is a raw
  // Postgres error about a missing relation, surfaced as a 502 that reads like
  // Sleeper was down — pointing at the wrong system entirely.
  const database = await databaseStatus();
  if (!database.configured) {
    return NextResponse.json(
      { error: 'No database is attached. Add one in your hosting provider, then redeploy.' },
      { status: 409 },
    );
  }
  if (!database.reachable) {
    return NextResponse.json(
      { error: `Database unreachable: ${database.error ?? 'unknown error'}` },
      { status: 503 },
    );
  }
  if (!database.migrated) {
    return NextResponse.json(
      {
        error:
          'The database is connected but has no schema yet. Create it first — there is a button for it on this page, or POST /api/admin/migrate.',
      },
      { status: 409 },
    );
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
