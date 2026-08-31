import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { encryptSecret, safeEqual } from '@/lib/crypto';
import { logger, errorFields } from '@/lib/logger';
import { siteUrl } from '@/lib/http';
import { getCurrentUser, createAdminClient } from '@/lib/supabase/server';
import { exchangeCode, GOOGLE_SCOPE, OAUTH_STATE_COOKIE } from '@/lib/google/calendar';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * OAuth callback. Always redirects back to /schedule with a status in the
 * query string — a raw JSON error here would strand the student on a blank page.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const back = (status: string) => NextResponse.redirect(`${siteUrl()}/schedule?google=${status}`);

  try {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    const jar = await cookies();
    const expectedState = jar.get(OAUTH_STATE_COOKIE)?.value;
    jar.delete(OAUTH_STATE_COOKIE);

    if (error) {
      logger.info('google.callback_declined', { error });
      return back('declined');
    }
    if (!code || !state || !expectedState || !safeEqual(state, expectedState)) {
      logger.warn('google.callback_bad_state');
      return back('state_mismatch');
    }

    const user = await getCurrentUser();
    if (!user) return back('signed_out');

    const tokens = await exchangeCode(code);

    // Without a refresh token the connection dies at the first expiry, so
    // treat its absence as a failed connection rather than a silent time bomb.
    if (!tokens.refresh_token) {
      logger.warn('google.callback_no_refresh_token', { userId: user.id });
      return back('no_refresh_token');
    }
    if (!tokens.scope?.includes(GOOGLE_SCOPE)) {
      logger.warn('google.callback_scope_missing', { userId: user.id, scope: tokens.scope });
      return back('scope_missing');
    }

    const supabase = createAdminClient();
    await supabase.from('calendar_connections').upsert(
      {
        user_id: user.id,
        provider: 'google',
        google_account_email: null,
        scope: tokens.scope,
        refresh_token_encrypted: encryptSecret(tokens.refresh_token),
        access_token_encrypted: encryptSecret(tokens.access_token),
        access_token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      },
      { onConflict: 'user_id' },
    );

    logger.info('google.connected', { userId: user.id });
    return back('connected');
  } catch (err) {
    logger.error('google.callback_failed', errorFields(err));
    return back('failed');
  }
}
