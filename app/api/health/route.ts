import { NextResponse } from 'next/server';
import { databaseStatus } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

/**
 * Setup diagnostics. Unauthenticated on purpose: it reports whether things are
 * configured, never what they are configured with. No connection string, no
 * key — only the *name* of the environment variable a value came from.
 */
export async function GET() {
  const database = await databaseStatus();

  const checks = {
    database,
    anthropic: { configured: Boolean(process.env.ANTHROPIC_API_KEY) },
    redis: {
      configured: Boolean(
        process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
      ),
    },
    cronSecret: { configured: Boolean(process.env.CRON_SECRET) },
  };

  const ready = database.configured && database.reachable && database.migrated;

  return NextResponse.json(
    {
      ready,
      nextStep: nextStep(database),
      checks,
    },
    { status: ready ? 200 : 503 },
  );
}

function nextStep(database: Awaited<ReturnType<typeof databaseStatus>>): string | null {
  if (!database.configured) {
    return 'Attach a Postgres database, then redeploy so the app picks up the environment variable.';
  }
  if (!database.reachable) {
    return `Database unreachable: ${database.error ?? 'unknown error'}`;
  }
  if (!database.migrated) {
    return 'Database is connected but empty. POST /api/admin/migrate to create the schema.';
  }
  return null;
}
