import { NextResponse } from 'next/server';
import { databaseStatus } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

/**
 * Setup diagnostics. Unauthenticated on purpose: it reports whether things are
 * configured, never what they are configured with. No connection string, no
 * key — only the *name* of the environment variable a value came from, plus the
 * deployment's own public identity.
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
      nextStep: nextStep(database, checks),
      // Which deployment is answering. When a database appears attached in the
      // dashboard but absent at runtime, the usual explanation is that the
      // dashboard and the running deployment are not the same thing — a
      // different project, a preview rather than production, or a build that
      // predates the variable. None of this is secret; Vercel exposes it to the
      // client bundle as a matter of course.
      deployment: {
        environment: process.env.VERCEL_ENV ?? 'local',
        repo: process.env.VERCEL_GIT_REPO_SLUG ?? null,
        owner: process.env.VERCEL_GIT_REPO_OWNER ?? null,
        branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
        commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
        url: process.env.VERCEL_URL ?? null,
        productionUrl: process.env.VERCEL_PROJECT_PRODUCTION_URL ?? null,
      },
      checks,
    },
    { status: ready ? 200 : 503 },
  );
}

function nextStep(
  database: Awaited<ReturnType<typeof databaseStatus>>,
  checks: { anthropic: { configured: boolean }; cronSecret: { configured: boolean } },
): string | null {
  if (!database.configured) {
    // No database variables *and* no other variables either means the
    // deployment has no environment configured at all, which is a different
    // problem from a database that was attached to the wrong place.
    const nothingElseSet = !checks.anthropic.configured && !checks.cronSecret.configured;
    if (database.seenEnvVars.length === 0 && nothingElseSet) {
      return (
        'This deployment has no environment variables at all — not just no database. ' +
        'Check that the variables are on the project named in `deployment` above, ' +
        'scoped to that environment, and that it has been redeployed since they were added.'
      );
    }
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
