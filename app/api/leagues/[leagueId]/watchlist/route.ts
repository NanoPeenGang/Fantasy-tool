import { NextResponse } from 'next/server';
import { z } from 'zod';
import { addToWatchlist, listWatchlist, removeFromWatchlist } from '@/lib/db/queries';

export const dynamic = 'force-dynamic';

const AddBody = z.object({
  playerId: z.string().min(1),
  managerId: z.string().uuid().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  priority: z.number().int().min(1).max(999).optional(),
});

export async function GET(
  request: Request,
  { params }: { params: Promise<{ leagueId: string }> },
) {
  const { leagueId } = await params;
  const managerId = new URL(request.url).searchParams.get('managerId');
  return NextResponse.json({ items: await listWatchlist(leagueId, managerId) });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ leagueId: string }> },
) {
  const { leagueId } = await params;
  let body: z.infer<typeof AddBody>;
  try {
    body = AddBody.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const item = await addToWatchlist({
    leagueId,
    managerId: body.managerId ?? null,
    playerId: body.playerId,
    note: body.note ?? null,
    priority: body.priority,
  });
  return NextResponse.json({ item });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ leagueId: string }> },
) {
  const { leagueId } = await params;
  const url = new URL(request.url);
  const playerId = url.searchParams.get('playerId');
  if (!playerId) return NextResponse.json({ error: 'playerId is required.' }, { status: 400 });

  await removeFromWatchlist(leagueId, playerId, url.searchParams.get('managerId'));
  return NextResponse.json({ ok: true });
}
