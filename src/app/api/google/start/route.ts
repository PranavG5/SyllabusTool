import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { AppError } from '@/lib/errors';
import { handle, requireUser } from '@/lib/http';
import { authorizationUrl, googleConfigured, OAUTH_STATE_COOKIE } from '@/lib/google/calendar';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Begins the Google Calendar connection, with CSRF state in an httpOnly cookie. */
export async function GET(): Promise<NextResponse> {
  return handle('GET /api/google/start', async () => {
    await requireUser();
    if (!googleConfigured()) {
      throw new AppError('internal', {
        userMessage: 'Google Calendar is not set up on this deployment yet.',
        nextAction: 'Download the .ics file or subscribe to your calendar feed instead.',
      });
    }

    const state = randomBytes(24).toString('base64url');
    const jar = await cookies();
    jar.set(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 600,
    });

    return NextResponse.redirect(authorizationUrl(state));
  });
}
