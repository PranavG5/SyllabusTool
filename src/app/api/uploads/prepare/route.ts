import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { handle, json, requireUser } from '@/lib/http';
import { getQuotaStatus } from '@/lib/quota';
import { createAdminClient } from '@/lib/supabase/server';
import { STORAGE_BUCKET } from '@/lib/jobs';
import { SUPPORTED_EXTENSIONS, SUPPORTED_MIME_TYPES, extensionOf } from '@/lib/parse/limits';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

/**
 * Hands the browser a one-time signed URL per file so it can upload straight
 * to the private bucket.
 *
 * Files do not pass through this application at all. A Vercel serverless
 * function rejects any request body over 4.5 MB with a plain-text 413, which
 * made the advertised limit of 20 MB per file across 10 files impossible to
 * honour through a normal upload — and produced an opaque failure when it hit.
 *
 * The path is chosen here, never by the client: `<user>/<batch>/<id>-<name>`.
 * The signed URL authorises exactly that one object, so a caller cannot aim an
 * upload at somebody else's folder.
 */

const Body = z.object({
  files: z
    .array(
      z.object({
        filename: z.string().min(1).max(255),
        sizeBytes: z.number().int().positive(),
        mimeType: z.string().max(160),
      }),
    )
    .min(1)
    .max(50),
});

function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file';
}

export async function POST(request: Request): Promise<NextResponse> {
  return handle('POST /api/uploads/prepare', async () => {
    const user = await requireUser();

    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError('invalid_input');
    const { files } = parsed.data;

    const quota = await getQuotaStatus(user.id);

    if (files.length > quota.limits.maxFilesPerBatch) {
      throw new AppError('too_many_files', {
        userMessage: `You can upload up to ${quota.limits.maxFilesPerBatch} files at a time.`,
      });
    }

    const oversized = files.find((f) => f.sizeBytes > quota.limits.maxFileBytes);
    if (oversized) {
      throw new AppError('file_too_large', {
        userMessage: `"${oversized.filename}" is ${(oversized.sizeBytes / 1024 / 1024).toFixed(1)} MB; the limit is ${Math.round(quota.limits.maxFileBytes / 1024 / 1024)} MB.`,
      });
    }

    const unsupported = files.find(
      (f) => !SUPPORTED_MIME_TYPES.has(f.mimeType) && !SUPPORTED_EXTENSIONS.has(extensionOf(f.filename)),
    );
    if (unsupported) {
      throw new AppError('unsupported_file_type', {
        userMessage: `We can't read "${unsupported.filename}" — we handle PDF, Word, text, and image files.`,
      });
    }

    const supabase = createAdminClient();
    const batchId = randomUUID();

    const targets = [];
    for (const file of files) {
      const uploadId = randomUUID();
      const path = `${user.id}/${batchId}/${uploadId}-${sanitizeFilename(file.filename)}`;

      const { data, error } = await supabase.storage
        .from(STORAGE_BUCKET)
        .createSignedUploadUrl(path);

      if (error || !data) {
        // Distinguish "this deployment was never finished" from "storage hiccup".
        // The first is a setup problem no amount of retrying fixes, and it is
        // exactly what happened here: a migration guard silently skipped
        // creating the bucket, and every upload failed with a generic message.
        const raw = (error?.message ?? '').toLowerCase();
        logger.error('uploads.sign_failed', { message: error?.message, path });

        if (raw.includes('bucket') && (raw.includes('not found') || raw.includes('does not exist'))) {
          throw new AppError('storage_not_configured', {
            detail: `The "${STORAGE_BUCKET}" storage bucket does not exist on this project.`,
            cause: error,
          });
        }
        if (raw.includes('jwt') || raw.includes('unauthorized') || raw.includes('invalid signature')) {
          throw new AppError('storage_failed', {
            detail: 'Storage rejected our credentials — SUPABASE_SERVICE_ROLE_KEY looks wrong.',
            cause: error,
          });
        }
        throw new AppError('storage_failed', {
          detail: error?.message ? `Storage said: ${error.message.slice(0, 120)}` : 'Storage gave no reason.',
          cause: error,
        });
      }

      targets.push({
        uploadId,
        filename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        path,
        token: data.token,
      });
    }

    logger.info('uploads.prepared', { userId: user.id, batchId, files: files.length });
    return json({ batchId, targets });
  });
}
