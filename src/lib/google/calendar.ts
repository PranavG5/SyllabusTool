import 'server-only';

/**
 * Google Calendar integration.
 *
 * Scope: `calendar.app.created` — the narrowest scope that works. It grants
 * access *only* to calendars this application itself created, so we
 * structurally cannot read or write the student's primary calendar even if we
 * had a bug that tried to. `calendar.events` and `calendar` would both work
 * and both grant far more; this one is the reason we can promise "we never
 * touch your other calendars" and mean it.
 *
 * That scope is still classified sensitive by Google, so production use
 * requires OAuth app verification. Budget several weeks: see docs/GOOGLE_OAUTH.md.
 *
 * Refresh tokens are AES-256-GCM encrypted before storage (lib/crypto), and
 * SELECT on the ciphertext columns is revoked from browser-facing roles.
 */

import { AppError } from '@/lib/errors';
import { logger, errorFields } from '@/lib/logger';
import { decryptSecret, encryptSecret } from '@/lib/crypto';
import { createAdminClient } from '@/lib/supabase/server';
import { siteUrl } from '@/lib/http';
import { calendarNameFor } from '@/lib/ics/response';
import { parseISODate, parseWallTime, zonedWallTimeToUtc, addDays, formatISODate } from '@/lib/datetime';
import { ITEM_TYPE_LABELS, type SchedulePayload } from '@/lib/types';

export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
/** httpOnly cookie holding the OAuth CSRF state between /start and /callback. */
export const OAUTH_STATE_COOKIE = 'gcal_oauth_state';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

function clientId(): string {
  const v = process.env.GOOGLE_CLIENT_ID;
  if (!v) throw new AppError('internal', { context: { reason: 'GOOGLE_CLIENT_ID not configured' } });
  return v;
}

function clientSecret(): string {
  const v = process.env.GOOGLE_CLIENT_SECRET;
  if (!v) throw new AppError('internal', { context: { reason: 'GOOGLE_CLIENT_SECRET not configured' } });
  return v;
}

export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function redirectUri(): string {
  return `${siteUrl()}/api/google/callback`;
}

export function authorizationUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: GOOGLE_SCOPE,
    // offline + consent is what actually returns a refresh token; without
    // prompt=consent a re-authorising user gets none and sync breaks later.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    logger.warn('google.token_failed', { status: response.status, detail: detail.slice(0, 300) });
    throw new AppError('google_auth_failed');
  }
  return (await response.json()) as TokenResponse;
}

export function exchangeCode(code: string): Promise<TokenResponse> {
  return postToken({
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  });
}

/**
 * Returns a usable access token, refreshing when the stored one is close to
 * expiry. A 60-second skew avoids handing out a token that dies mid-request.
 */
export async function accessTokenFor(userId: string): Promise<{ token: string; calendarId: string | null }> {
  const supabase = createAdminClient();
  const { data: connection } = await supabase
    .from('calendar_connections')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (!connection) throw new AppError('calendar_not_connected');

  const expiresAt = connection.access_token_expires_at
    ? new Date(connection.access_token_expires_at).getTime()
    : 0;
  if (connection.access_token_encrypted && expiresAt - Date.now() > 60_000) {
    return {
      token: decryptSecret(connection.access_token_encrypted),
      calendarId: connection.google_calendar_id,
    };
  }

  const refreshed = await postToken({
    refresh_token: decryptSecret(connection.refresh_token_encrypted),
    client_id: clientId(),
    client_secret: clientSecret(),
    grant_type: 'refresh_token',
  });

  await supabase
    .from('calendar_connections')
    .update({
      access_token_encrypted: encryptSecret(refreshed.access_token),
      access_token_expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
    })
    .eq('user_id', userId);

  return { token: refreshed.access_token, calendarId: connection.google_calendar_id };
}

async function googleFetch(token: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${CALENDAR_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    logger.warn('google.api_failed', { path, status: response.status, detail: detail.slice(0, 300) });
    throw new AppError('google_auth_failed', {
      userMessage: 'Google rejected that calendar request.',
      nextAction: 'Disconnect and reconnect Google Calendar, then try again.',
    });
  }
  return response.status === 204 ? null : await response.json();
}

/**
 * Creates a dedicated calendar. Never the primary one: with
 * `calendar.app.created` we could not write to it anyway, which is the point —
 * the student can hide or delete everything we made in a single action.
 */
export async function ensureDedicatedCalendar(
  userId: string,
  termName: string,
): Promise<{ calendarId: string; calendarName: string }> {
  const supabase = createAdminClient();
  const { data: connection } = await supabase
    .from('calendar_connections')
    .select('google_calendar_id, calendar_name')
    .eq('user_id', userId)
    .maybeSingle();

  if (connection?.google_calendar_id) {
    return {
      calendarId: connection.google_calendar_id,
      calendarName: connection.calendar_name ?? calendarNameFor(termName),
    };
  }

  const { token } = await accessTokenFor(userId);
  const calendarName = calendarNameFor(termName);
  const created = (await googleFetch(token, '/calendars', {
    method: 'POST',
    body: JSON.stringify({ summary: calendarName, description: 'Created by Syllabus Tool. Safe to delete.' }),
  })) as { id: string };

  await supabase
    .from('calendar_connections')
    .update({ google_calendar_id: created.id, calendar_name: calendarName })
    .eq('user_id', userId);

  logger.info('google.calendar_created', { userId, calendarId: created.id });
  return { calendarId: created.id, calendarName };
}

function timingFor(dateISO: string, time: string | null, timeZone: string): Record<string, unknown> {
  const date = parseISODate(dateISO)!;
  if (!time) {
    return { start: { date: dateISO }, end: { date: formatISODate(addDays(date, 1)) } };
  }
  const parsed = parseWallTime(time)!;
  const startInstant = zonedWallTimeToUtc(date, parsed, timeZone);
  const minutesIntoDay = parsed.hour * 60 + parsed.minute;
  // Same clamp as the ICS builder: never spill a 23:59 deadline into tomorrow.
  const durationMinutes = Math.min(30, Math.max(24 * 60 - minutesIntoDay - 1, 1));
  const endInstant = new Date(startInstant.getTime() + durationMinutes * 60_000);
  return {
    start: { dateTime: startInstant.toISOString(), timeZone },
    end: { dateTime: endInstant.toISOString(), timeZone },
  };
}

export interface SyncResult {
  calendarId: string;
  calendarName: string;
  written: number;
  skipped: number;
}

/**
 * Pushes the schedule into the dedicated calendar.
 *
 * Uses PUT with a deterministic event id derived from the item's row id — the
 * same identity the ICS UID uses — so a second sync updates the events already
 * there instead of duplicating them.
 */
export async function syncToGoogle(userId: string, payload: SchedulePayload): Promise<SyncResult> {
  const { calendarId, calendarName } = await ensureDedicatedCalendar(userId, payload.term.name);
  const { token } = await accessTokenFor(userId);
  const coursesById = new Map(payload.courses.map((c) => [c.id, c]));

  let written = 0;
  let skipped = 0;

  for (const item of payload.items) {
    const course = coursesById.get(item.courseId);
    if (item.status !== 'active' || !item.dueDate || !course) {
      skipped += 1;
      continue;
    }

    const body = {
      id: googleEventId(item.id),
      summary: `${course.code} — ${item.title}`,
      description: [
        `${ITEM_TYPE_LABELS[item.type]} · ${course.code}`,
        item.timeIsDefault ? 'No time was given in the syllabus; 11:59 PM assumed.' : '',
        '',
        'From your syllabus:',
        item.sourceSnippet,
        '',
        `Edit: ${siteUrl()}/schedule`,
      ].filter(Boolean).join('\n'),
      ...(item.location ? { location: item.location } : {}),
      ...timingFor(item.dueDate, item.dueTime, payload.term.timezone),
      reminders: {
        useDefault: false,
        overrides: item.dueTime
          ? [{ method: 'popup', minutes: 24 * 60 }, { method: 'popup', minutes: 120 }]
          : [{ method: 'popup', minutes: 14 * 60 }],
      },
      source: { title: 'Syllabus Tool', url: `${siteUrl()}/schedule` },
    };

    try {
      await googleFetch(token, `/calendars/${encodeURIComponent(calendarId)}/events/${body.id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      written += 1;
    } catch (err) {
      // One rejected event should not abandon the rest of the semester.
      skipped += 1;
      logger.warn('google.event_failed', { itemId: item.id, ...errorFields(err) });
    }
  }

  await createAdminClient()
    .from('calendar_connections')
    .update({ last_synced_at: new Date().toISOString() })
    .eq('user_id', userId);

  logger.info('google.synced', { userId, written, skipped });
  return { calendarId, calendarName, written, skipped };
}

/**
 * Google event ids must be 5-1024 characters of base32hex (0-9, a-v). A UUID's
 * hex digits are already a subset, so stripping the dashes is enough — and it
 * keeps the id derived from the same row id as the ICS UID, so both surfaces
 * address the same event rather than creating rivals.
 */
export function googleEventId(itemId: string): string {
  const hex = itemId.replace(/-/g, '').toLowerCase();
  if (/^[0-9a-v]{5,1024}$/.test(hex)) return hex;
  const safe = hex.replace(/[^0-9a-v]/g, '0');
  return `st${safe}`.slice(0, 1024).padEnd(5, '0');
}

/** Disconnect: revoke at Google (best effort), then delete our copy (certain). */
export async function revokeGoogleAccess(userId: string): Promise<void> {
  const supabase = createAdminClient();
  const { data: connection } = await supabase
    .from('calendar_connections')
    .select('refresh_token_encrypted')
    .eq('user_id', userId)
    .maybeSingle();

  if (connection?.refresh_token_encrypted) {
    try {
      const refreshToken = decryptSecret(connection.refresh_token_encrypted);
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken }).toString(),
      });
    } catch (err) {
      // Revocation is best-effort; deleting our copy is the part we control.
      logger.warn('google.revoke_failed', { userId, ...errorFields(err) });
    }
  }

  await supabase.from('calendar_connections').delete().eq('user_id', userId);
}
