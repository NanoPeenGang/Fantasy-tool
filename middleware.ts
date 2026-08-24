import { NextResponse, type NextRequest } from 'next/server';

/**
 * Auth middleware.
 *
 * Clerk is optional. When its keys are absent the middleware is a pass-through
 * rather than a hard failure, so the app boots for local development and for a
 * self-hosted single-league deployment without an auth provider. Wiring Clerk
 * in is a matter of setting the two environment variables and swapping this for
 * `clerkMiddleware()` — see the README.
 */
export function middleware(_request: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
