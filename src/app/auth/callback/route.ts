import { NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Exchanges the magic-link / OAuth code for a session cookie. */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next');

  // Only ever redirect within this app — an open redirect here would be a
  // phishing primitive attached to a real sign-in flow.
  const destination = next && next.startsWith('/') && !next.startsWith('//') ? next : '/input';

  /**
   * Resolve against the URL the browser actually requested, not the configured
   * site URL. The session cookie is set on the host the student is on, so
   * sending them anywhere else logs them out again — and a mistyped
   * NEXT_PUBLIC_SITE_URL would eject them onto a domain we do not even own
   * part-way through signing in. That happened on the first deployment here.
   *
   * `destination` is already constrained to a same-origin path above, so this
   * cannot become an open redirect.
   */
  const here = (path: string) => new URL(path, request.url);

  if (!code) return NextResponse.redirect(here('/login?error=missing_code'));

  const supabase = await createServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    logger.warn('auth.exchange_failed', { message: error.message });
    return NextResponse.redirect(here('/login?error=link_expired'));
  }

  return NextResponse.redirect(here(destination));
}
