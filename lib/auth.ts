import 'server-only';

import { NextResponse } from 'next/server';

/**
 * Cron routes are triggered by Vercel Cron, which sends CRON_SECRET as a bearer
 * token. When no secret is configured the routes stay open, which is fine for
 * local development and must not be the production posture — the deploy guide
 * calls that out.
 */
export function authorizeCron(request: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;

  const header = request.headers.get('authorization');
  if (header === `Bearer ${secret}`) return null;

  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}

/**
 * Sleeper has no OAuth, so accounts are local and league ownership is recorded
 * at connect time. Clerk is optional: when it is not configured the app runs
 * open, which is the right default for a self-hosted single-league deployment.
 */
export function isAuthConfigured(): boolean {
  return Boolean(process.env.CLERK_SECRET_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
}

export type MigrateAccess = 'bootstrap' | 'authorized' | 'denied';

/**
 * Who may create the schema.
 *
 * The bootstrap case is the interesting one: while the database is completely
 * empty, the migration runs without a secret. That is a deliberate, bounded
 * exception, not an oversight. The only thing the call can do in that state is
 * create empty tables on an empty database — it cannot read anything, because
 * there is nothing to read, and it cannot destroy anything, because every
 * statement is additive. The window closes the instant it succeeds.
 *
 * A *partially* migrated database — one behind a schema change — is deliberately
 * not bootstrappable: it holds real data, so bringing it up to date is an
 * ordinary admin write and takes the secret like any other.
 *
 * The alternative is worse: someone who has just attached a database and has not
 * yet set CRON_SECRET would have no way to finish setup from the browser, which
 * is exactly the dead end this whole route exists to remove.
 *
 * Once the schema exists, the secret is required like any other admin write.
 */
export function decideMigrateAccess(params: {
  secret: string | undefined;
  authorization: string | null;
  /** True only when the database has none of the app's tables. */
  emptyDatabase: boolean;
}): MigrateAccess {
  if (params.emptyDatabase) return 'bootstrap';
  if (!params.secret) return 'authorized';
  return params.authorization === `Bearer ${params.secret}` ? 'authorized' : 'denied';
}
