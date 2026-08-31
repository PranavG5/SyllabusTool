import { NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { siteUrl } from '@/lib/http';
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

  if (!code) return NextResponse.redirect(`${siteUrl()}/login?error=missing_code`);

  const supabase = await createServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    logger.warn('auth.exchange_failed', { message: error.message });
    return NextResponse.redirect(`${siteUrl()}/login?error=link_expired`);
  }

  return NextResponse.redirect(`${siteUrl()}${destination}`);
}
