import { NextResponse } from 'next/server';
import { getLeague } from '@/lib/db/queries';
import { importDraftHistory } from '@/lib/jobs/draft';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Pull every draft this room has run, chaining back through previous_league_id.
 *
 * Run once on connect and again whenever a new draft finishes. Idempotent —
 * picks are keyed by (draft_id, pick_no), so re-importing overwrites rather
 * than duplicating.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ leagueId: string }> },
) {
  const { leagueId } = await params;
  const league = await getLeague(leagueId);
  if (!league) return NextResponse.json({ error: 'Unknown league.' }, { status: 404 });

  const seasons = Number(new URL(request.url).searchParams.get('seasons') ?? '6');

  try {
    const result = await importDraftHistory(league, { maxSeasons: seasons });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Import failed.' },
      { status: 502 },
    );
  }
}
