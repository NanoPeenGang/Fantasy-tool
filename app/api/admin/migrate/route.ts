import { NextResponse } from 'next/server';
import { decideMigrateAccess } from '@/lib/auth';
import { applySchema, databaseStatus, isDatabaseConfigured } from '@/lib/db/client';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Apply the schema to the connected database.
 *
 * A deployed app has no shell, so `npm run db:migrate` is unreachable once the
 * database lives in Vercel or Neon rather than on a laptop. This route is the
 * production path for the same operation, and it is what the setup banner calls.
 *
 * Access rules live in `decideMigrateAccess` — an unmigrated database can be
 * bootstrapped without a secret; a migrated one cannot.
 */
export async function POST(request: Request) {
  if (!isDatabaseConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'No Postgres connection string is set. Attach a database first.' },
      { status: 409 },
    );
  }

  const before = await databaseStatus();
  if (!before.reachable) {
    return NextResponse.json(
      { ok: false, error: `Database unreachable: ${before.error ?? 'unknown error'}` },
      { status: 502 },
    );
  }

  const access = decideMigrateAccess({
    secret: process.env.CRON_SECRET,
    authorization: request.headers.get('authorization'),
    migrated: before.migrated,
  });

  if (access === 'denied') {
    return NextResponse.json(
      { ok: false, error: 'The schema already exists. Re-running it requires CRON_SECRET.' },
      { status: 401 },
    );
  }

  try {
    await applySchema();
    return NextResponse.json({ ok: true, access, status: await databaseStatus() });
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
