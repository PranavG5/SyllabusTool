import { NextResponse } from 'next/server';
import { handle, json } from '@/lib/http';
import { AppError } from '@/lib/errors';
import { createAdminClient } from '@/lib/supabase/server';
import { STORAGE_BUCKET } from '@/lib/jobs';
import { safeEqual } from '@/lib/crypto';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * 30-day retention sweep. Wire to a Vercel Cron (see vercel.json).
 *
 * Two phases on purpose: storage objects are deleted first, and only the ids
 * that actually left storage have their rows removed. A row without its blob
 * is recoverable on the next run; a blob without its row is invisible garbage
 * that nothing will ever clean up.
 */
export async function GET(request: Request): Promise<NextResponse> {
  return handle('GET /api/cron/purge', async () => {
    const secret = process.env.CRON_SECRET ?? process.env.JOB_WORKER_SECRET;
    const header = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (!secret || !safeEqual(header, secret)) throw new AppError('unauthorized');

    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc('list_expired_uploads', { p_limit: 500 });
    if (error) throw new AppError('internal', { context: { reason: error.message } });

    const expired = (data ?? []) as { id: string; user_id: string; storage_path: string | null }[];
    if (expired.length === 0) return json({ deleted: 0, remaining: 0 });

    const withPaths = expired.filter((u) => u.storage_path);
    const deletable = new Set(expired.filter((u) => !u.storage_path).map((u) => u.id));

    if (withPaths.length > 0) {
      const { error: removeError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .remove(withPaths.map((u) => u.storage_path!));
      if (removeError) {
        logger.warn('cron.storage_remove_failed', { message: removeError.message });
      } else {
        for (const u of withPaths) deletable.add(u.id);
      }
    }

    const ids = [...deletable];
    const { data: deleted } = await supabase.rpc('delete_purged_uploads', { p_ids: ids });

    logger.info('cron.purged', { deleted: deleted ?? 0, considered: expired.length });
    return json({ deleted: deleted ?? 0, considered: expired.length });
  });
}
