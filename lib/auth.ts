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
