import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getLeague, upsertProjections, weekProjections } from '@/lib/db/queries';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Import projections.
 *
 * The projection source is the spec's one open decision, and this is the seam
 * for it: paste in whatever you have — a consensus scrape, a vendor feed,
 * market-implied prop lines — and the odds board, the draft board and the
 * start/sit advisor all light up. `source` is stored per row so two sources can
 * coexist and be blended later without a rewrite.
 *
 * Week 0 is the convention for season-long totals, which is what the draft
 * board wants; weeks 1-18 are the weekly numbers the lineup advisor wants.
 */
const Body = z.object({
  week: z.number().int().min(0).max(22),
  source: z.string().min(1).max(40).default('import'),
  season: z.string().regex(/^\d{4}$/).optional(),
  projections: z
    .array(
      z.object({
        playerId: z.string().min(1),
        mean: z.number().finite(),
        sd: z.number().finite().nullable().optional(),
      }),
    )
    .min(1)
    .max(5000),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ leagueId: string }> },
) {
  const { leagueId } = await params;
  const league = await getLeague(leagueId);
  if (!league) return NextResponse.json({ error: 'Unknown league.' }, { status: 404 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await request.json());
  } catch (error) {
    const message =
      error instanceof z.ZodError ? error.issues[0]?.message ?? 'Invalid body.' : 'Invalid body.';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const season = body.season ?? league.season;
  await upsertProjections(season, body.week, body.source, body.projections);

  return NextResponse.json({
    ok: true,
    season,
    week: body.week,
    source: body.source,
    imported: body.projections.length,
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ leagueId: string }> },
) {
  const { leagueId } = await params;
  const league = await getLeague(leagueId);
  if (!league) return NextResponse.json({ error: 'Unknown league.' }, { status: 404 });

  const week = Number(new URL(request.url).searchParams.get('week') ?? '0');
  const projections = await weekProjections(league.season, week);
  return NextResponse.json({ season: league.season, week, count: Object.keys(projections).length });
}
