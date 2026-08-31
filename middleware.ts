import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

/**
 * Refreshes the Supabase session cookie on navigation, so a signed-in student
 * does not get bounced to the login screen when their access token rolls over.
 *
 * This is not an authorisation layer: every route re-checks the session, and
 * the database enforces RLS regardless. Middleware only keeps the cookie fresh.
 */
/**
 * Supabase sends an auth code to the project's configured Site URL, which is
 * the site root, not our callback route. Only `emailRedirectTo` targets
 * /auth/callback, and Supabase silently falls back to the Site URL whenever
 * that value is not in the project's redirect allow-list.
 *
 * When that happens the student lands on the landing page, still signed out,
 * with a `?code=` in the address bar and no idea why nothing worked. Catching
 * it here and forwarding to the callback makes sign-in survive a
 * misconfigured allow-list.
 *
 * Not a security hole: the code is single-use and PKCE ties it to the
 * code_verifier cookie in the browser that requested it, so a code pasted from
 * elsewhere fails the exchange and lands on /login with an explanation.
 */
function authCodeRedirect(request: NextRequest): NextResponse | null {
  const { pathname, searchParams } = request.nextUrl;
  if (pathname.startsWith('/auth/') || pathname.startsWith('/api/')) return null;
  if (!searchParams.has('code') && !searchParams.has('token_hash')) return null;

  const target = request.nextUrl.clone();
  target.pathname = '/auth/callback';
  // Preserve where they were headed, so the callback can send them back there.
  if (pathname !== '/' && !target.searchParams.has('next')) {
    target.searchParams.set('next', pathname);
  }
  return NextResponse.redirect(target);
}

export async function middleware(request: NextRequest) {
  const forwarded = authCodeRedirect(request);
  if (forwarded) return forwarded;

  const response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value, options } of toSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  await supabase.auth.getUser();
  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and the calendar feed. The feed
     * authenticates by token and is polled by calendar clients that carry no
     * cookies, so running session refresh on it would be pure overhead.
     */
    '/((?!_next/static|_next/image|favicon.ico|api/feed|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
