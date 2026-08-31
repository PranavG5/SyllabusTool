import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

/**
 * Refreshes the Supabase session cookie on navigation, so a signed-in student
 * does not get bounced to the login screen when their access token rolls over.
 *
 * This is not an authorisation layer: every route re-checks the session, and
 * the database enforces RLS regardless. Middleware only keeps the cookie fresh.
 */
export async function middleware(request: NextRequest) {
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
