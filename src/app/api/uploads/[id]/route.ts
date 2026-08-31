import { NextResponse } from 'next/server';
import { AppError } from '@/lib/errors';
import { handle, json, requireUser } from '@/lib/http';
import { createAdminClient } from '@/lib/supabase/server';
import { STORAGE_BUCKET } from '@/lib/jobs';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mints a short-lived signed URL for one of the caller's own uploads, so a
 * student can open the original PDF behind a review row.
 *
 * The bucket is private and has no public object URLs; this is the only way a
 * file leaves storage. Ownership is checked against the row before signing —
 * the service role bypasses RLS, so that check is the access control.
 */
const SIGNED_URL_TTL_SECONDS = 300;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return handle('GET /api/uploads/[id]', async () => {
    const user = await requireUser();
    const { id } = await params;

    const supabase = createAdminClient();
    const { data: upload } = await supabase
      .from('uploads')
      .select('id, user_id, storage_path, filename, purge_after')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (!upload) throw new AppError('not_found');

    if (!upload.storage_path) {
      throw new AppError('not_found', {
        userMessage: `We do not have a stored copy of "${upload.filename}".`,
        nextAction: 'The source text on the item is still there to check against.',
      });
    }

    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(upload.storage_path, SIGNED_URL_TTL_SECONDS, { download: upload.filename });

    if (error || !data?.signedUrl) {
      // Most likely the 30-day retention sweep already removed the object.
      logger.warn('uploads.sign_failed', { uploadId: id, message: error?.message });
      throw new AppError('not_found', {
        userMessage: `"${upload.filename}" is no longer stored — we delete uploads 30 days after processing.`,
        nextAction: 'The source text on the item is still there to check against.',
      });
    }

    return json({
      url: data.signedUrl,
      filename: upload.filename,
      expiresInSeconds: SIGNED_URL_TTL_SECONDS,
      purgeAfter: upload.purge_after,
    });
  });
}
