import { NextResponse } from 'next/server';
import { AppError } from '@/lib/errors';
import { handle, requireUser } from '@/lib/http';
import { createServerClient, createAdminClient } from '@/lib/supabase/server';
import { loadSchedule } from '@/lib/schedule/load';
import { icsResponse } from '@/lib/ics/response';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One-off .ics download. The primary export path. */
export async function GET(request: Request): Promise<NextResponse> {
  return handle('GET /api/export/ics', async () => {
    const user = await requireUser();
    const termId = new URL(request.url).searchParams.get('termId');

    const supabase = await createServerClient();
    const payload = await loadSchedule(supabase, termId);
    if (!payload) throw new AppError('not_found');

    void createAdminClient()
      .from('usage_events')
      .insert({ user_id: user.id, kind: 'export_ics', files_count: payload.items.length })
      .then(({ error }) => {
        if (error) logger.warn('export.usage_log_failed', { message: error.message });
      });

    return icsResponse(payload, { download: true });
  });
}
