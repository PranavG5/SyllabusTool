import { NextResponse } from 'next/server';
import { AppError } from '@/lib/errors';
import { handle, json, requireUser, siteUrl } from '@/lib/http';
import { createAdminClient } from '@/lib/supabase/server';
import { getQuotaStatus } from '@/lib/quota';
import { revokeGoogleAccess } from '@/lib/google/calendar';
import { STORAGE_BUCKET } from '@/lib/jobs';
import { logger, errorFields } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Account summary: quota, feed URL, Google connection state. */
export async function GET(): Promise<NextResponse> {
  return handle('GET /api/account', async () => {
    const user = await requireUser();
    const supabase = createAdminClient();

    const [{ data: profile }, { data: connection }, quota] = await Promise.all([
      supabase.from('users').select('plan, feed_token, created_at').eq('id', user.id).maybeSingle(),
      supabase
        .from('calendar_connections')
        .select('calendar_name, google_calendar_id, last_synced_at')
        .eq('user_id', user.id)
        .maybeSingle(),
      getQuotaStatus(user.id),
    ]);

    return json({
      email: user.email,
      plan: profile?.plan ?? 'free',
      createdAt: profile?.created_at ?? null,
      quota: { used: quota.used, limit: quota.limit, remaining: quota.remaining },
      limits: quota.limits,
      feedUrl: profile?.feed_token ? `${siteUrl()}/api/feed/${profile.feed_token}.ics` : null,
      google: connection
        ? {
            connected: true,
            calendarName: connection.calendar_name,
            lastSyncedAt: connection.last_synced_at,
          }
        : { connected: false, calendarName: null, lastSyncedAt: null },
    });
  });
}

/**
 * Account deletion that actually deletes.
 *
 * Order matters: OAuth tokens are revoked at Google first (the only step that
 * needs the plaintext), then storage objects, then every database row, then
 * the auth identity. A failure part-way leaves less data behind than it
 * started with, never more.
 */
export async function DELETE(request: Request): Promise<NextResponse> {
  return handle('DELETE /api/account', async () => {
    const user = await requireUser();

    // Deleting an account is irreversible, so require an explicit confirmation
    // rather than letting a stray fetch do it.
    const body = (await request.json().catch(() => ({}))) as { confirm?: string };
    if (body.confirm !== 'DELETE') {
      throw new AppError('invalid_input', {
        userMessage: 'Deleting your account needs an explicit confirmation.',
        nextAction: 'Type DELETE in the confirmation box.',
      });
    }

    const supabase = createAdminClient();

    // 1. Revoke Google access while we can still decrypt the refresh token.
    await revokeGoogleAccess(user.id).catch((err) =>
      logger.warn('account.revoke_failed', { userId: user.id, ...errorFields(err) }),
    );

    // 2. Delete uploaded files from the private bucket.
    const { data: uploads } = await supabase
      .from('uploads')
      .select('storage_path')
      .eq('user_id', user.id)
      .not('storage_path', 'is', null);

    const paths = (uploads ?? []).map((u) => u.storage_path).filter((p): p is string => Boolean(p));
    if (paths.length > 0) {
      const { error } = await supabase.storage.from(STORAGE_BUCKET).remove(paths);
      if (error) logger.warn('account.storage_delete_failed', { userId: user.id, message: error.message });
    }

    // 3. Delete every row, explicitly rather than by cascade.
    const { error: purgeError } = await supabase.rpc('purge_user_data', { p_user_id: user.id });
    if (purgeError) {
      logger.error('account.purge_failed', { userId: user.id, message: purgeError.message });
      throw new AppError('internal', { context: { reason: 'purge failed' } });
    }

    // 4. Delete the auth identity itself.
    const { error: authError } = await supabase.auth.admin.deleteUser(user.id);
    if (authError) {
      logger.error('account.auth_delete_failed', { userId: user.id, message: authError.message });
      throw new AppError('internal', { context: { reason: 'auth delete failed' } });
    }

    logger.info('account.deleted', { userId: user.id, files: paths.length });
    return json({ deleted: true });
  });
}
