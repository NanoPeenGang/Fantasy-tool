import { NextResponse } from 'next/server';
import { authorizeCron } from '@/lib/auth';
import { refreshPlayerDictionary } from '@/lib/sleeper/players';

export const dynamic = 'force-dynamic';
/**
 * The dictionary is ~10MB and the reduce walks every entry. 60s is the Hobby
 * ceiling and is comfortable for this; it is the fan-out jobs that feel it.
 */
export const maxDuration = 60;

/**
 * Daily player dictionary refresh.
 *
 * Sleeper asks that /players/nfl be called at most once per day, so this route
 * must stay on a daily schedule — it is the only caller of the raw endpoint in
 * the app.
 */
export async function GET(request: Request) {
  const denied = authorizeCron(request);
  if (denied) return denied;

  try {
    const result = await refreshPlayerDictionary();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Refresh failed.';
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
