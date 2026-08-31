import { NextResponse } from 'next/server';
import { AppError } from '@/lib/errors';
import { handle, json, requireUser } from '@/lib/http';
import { createServerClient, createAdminClient } from '@/lib/supabase/server';
import { loadSchedule } from '@/lib/schedule/load';
import { syncToGoogle } from '@/lib/google/calendar';
import { consumeRateLimit } from '@/lib/quota';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 120;

/** Writes the schedule into the dedicated Google calendar. */
export async function POST(request: Request): Promise<NextResponse> {
  return handle('POST /api/google/sync', async () => {
    const user = await requireUser();

    // A sync is one API call per item; keep an accidental loop from hammering Google.
    if (!(await consumeRateLimit(`gcal:${user.id}`, 10, 3600))) {
      throw new AppError('rate_limited', {
        userMessage: "You've synced to Google several times in the last hour.",
        nextAction: 'Wait a few minutes — your existing events are already up to date.',
      });
    }

    const termId = new URL(request.url).searchParams.get('termId');
    const supabase = await createServerClient();
    const payload = await loadSchedule(supabase, termId);
    if (!payload) throw new AppError('not_found');

    const result = await syncToGoogle(user.id, payload);

    void createAdminClient()
      .from('usage_events')
      .insert({ user_id: user.id, kind: 'gcal_sync', files_count: result.written })
      .then(({ error }) => {
        if (error) logger.warn('gcal.usage_log_failed', { message: error.message });
      });

    return json(result);
  });
}
