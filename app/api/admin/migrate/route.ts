import { NextResponse } from 'next/server';
import { authorizeCron } from '@/lib/auth';
import { applySchema, databaseStatus, isDatabaseConfigured } from '@/lib/db/client';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Apply the schema to the connected database.
 *
 * A deployed app has no shell, so `npm run db:migrate` is not reachable once the
 * database lives in Vercel or Neon rather than on a laptop. This route is the
 * production path for the same operation.
 *
 * Guarded by CRON_SECRET, using the same check as the cron routes: it is an
 * administrative write, and while every statement is idempotent and additive —
 * nothing here drops or truncates — it should still not be open to the internet.
 */
export async function POST(request: Request) {
  const denied = authorizeCron(request);
  if (denied) return denied;

  if (!isDatabaseConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'No Postgres connection string is set. Attach a database first.' },
      { status: 409 },
    );
  }

  try {
    await applySchema();
    const status = await databaseStatus();
    return NextResponse.json({ ok: true, status });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Migration failed.' },
      { status: 500 },
    );
  }
}

/** GET reports what a POST would do, so the state is checkable from a browser. */
export async function GET() {
  return NextResponse.json({ status: await databaseStatus() });
}
