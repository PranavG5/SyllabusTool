import { NextResponse, after } from 'next/server';
import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { handle, json, requireUser } from '@/lib/http';
import { consumeExtractionQuota } from '@/lib/quota';
import { parseFile, type ParsedFile } from '@/lib/parse';
import { createJob, triggerWorker, STORAGE_BUCKET } from '@/lib/jobs';
import { createAdminClient } from '@/lib/supabase/server';
import { logger, errorFields } from '@/lib/logger';
import { parseMeetingDays } from '@/lib/schedule/relative-dates';
import { isValidTimeZone, parseISODate } from '@/lib/datetime';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Starts a schedule build.
 *
 * Files arrive already in the private bucket — the browser uploaded them
 * directly with the signed URLs from /api/uploads/prepare, because a Vercel
 * serverless function cannot accept a request body over 4.5 MB. This route
 * receives only their ids and paths, which keeps the request tiny however
 * large the syllabus is.
 *
 * Order still matters:
 *   1. Quota first, so an over-limit user is refused before any work.
 *   2. Download and parse every file, so an encrypted PDF or a 300-page course
 *      pack is rejected with a clear message and costs no API call.
 *   3. Only then create the job and hand off to the background worker.
 */

const MAX_PASTED_CHARS = 400_000;

const Body = z.object({
  batchId: z.string().uuid().nullable().optional(),
  uploads: z
    .array(
      z.object({
        uploadId: z.string().uuid(),
        filename: z.string().min(1).max(255),
        mimeType: z.string().max(160),
        sizeBytes: z.number().int().nonnegative(),
        path: z.string().min(1).max(500),
      }),
    )
    .max(50)
    .default([]),
  text: z.string().nullable().optional(),
  courseHint: z.string().max(120).nullable().optional(),
  termName: z.string().max(120).nullable().optional(),
  termStartDate: z.string().nullable().optional(),
  termEndDate: z.string().nullable().optional(),
  meetingDays: z.string().max(60).nullable().optional(),
  timezone: z.string().max(60).nullable().optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  return handle('POST /api/extract', async () => {
    const user = await requireUser();

    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError('invalid_input');
    const body = parsed.data;

    const pastedText = body.text?.trim() || null;
    const uploads = body.uploads ?? [];

    if (uploads.length === 0 && !pastedText) throw new AppError('no_input');
    if (pastedText && pastedText.length > MAX_PASTED_CHARS) {
      throw new AppError('input_too_long', {
        userMessage: `That is ${pastedText.length.toLocaleString()} characters; we read up to ${MAX_PASTED_CHARS.toLocaleString()} in one go.`,
      });
    }
    if (body.termStartDate && !parseISODate(body.termStartDate)) {
      throw new AppError('invalid_input', {
        userMessage: 'That term start date was not a real date.',
        nextAction: 'Pick the first day of classes and try again.',
      });
    }

    // Every path must sit inside this user's own folder. The signed URL already
    // pins the object, but a forged `path` here would otherwise let a caller
    // point the parser at somebody else's upload.
    const prefix = `${user.id}/`;
    if (uploads.some((u) => !u.path.startsWith(prefix) || u.path.includes('..'))) {
      throw new AppError('invalid_input', { context: { reason: 'upload path outside user folder' } });
    }

    // 1. Quota. Throws when refused, so nothing below runs for an over-limit user.
    const quota = await consumeExtractionQuota(user.id, uploads.length + (pastedText ? 1 : 0));

    // 2. Fetch and parse each file up front, so failures are specific and free.
    const supabase = createAdminClient();
    const prepared: {
      uploadId: string; filename: string; mimeType: string; sizeBytes: number;
      pageCount: number | null; parsed: ParsedFile; storagePath: string;
    }[] = [];
    const rejected: { filename: string; reason: string }[] = [];

    for (const upload of uploads) {
      if (upload.sizeBytes > quota.limits.maxFileBytes) {
        rejected.push({
          filename: upload.filename,
          reason: `This file is ${(upload.sizeBytes / 1024 / 1024).toFixed(1)} MB; the limit is ${Math.round(quota.limits.maxFileBytes / 1024 / 1024)} MB.`,
        });
        continue;
      }

      const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(upload.path);
      if (error || !data) {
        logger.warn('extract.download_failed', { filename: upload.filename, message: error?.message });
        rejected.push({ filename: upload.filename, reason: 'The upload did not finish, so we could not read it.' });
        continue;
      }

      const bytes = new Uint8Array(await data.arrayBuffer());
      try {
        const parsedFile = await parseFile({
          filename: upload.filename,
          mimeType: upload.mimeType || 'application/octet-stream',
          bytes,
          maxPdfPages: quota.limits.maxPdfPages,
        });
        prepared.push({
          uploadId: upload.uploadId,
          filename: upload.filename,
          mimeType: upload.mimeType || 'application/octet-stream',
          sizeBytes: upload.sizeBytes,
          pageCount: parsedFile.pageCount,
          parsed: parsedFile,
          storagePath: upload.path,
        });
      } catch (err) {
        rejected.push({
          filename: upload.filename,
          reason: err instanceof AppError ? err.userMessage : 'We could not read this file.',
        });
        logger.info('extract.file_rejected', { filename: upload.filename, ...errorFields(err) });
      }
    }

    if (prepared.length === 0 && !pastedText) {
      throw new AppError('unparseable_file', {
        userMessage: rejected.length === 1 ? rejected[0]!.reason : 'None of those files could be read.',
        nextAction: 'Try a different format, or paste the schedule text instead.',
        context: { rejected },
      });
    }

    // 3. Make sure there is a term to hang the schedule off.
    const timezone = body.timezone?.trim() || 'America/New_York';
    const termId = await ensureTerm(user.id, {
      name: body.termName?.trim() || 'My term',
      timezone: isValidTimeZone(timezone) ? timezone : 'America/New_York',
      startDate: body.termStartDate || null,
      endDate: body.termEndDate || null,
      meetingDays: parseMeetingDays(body.meetingDays ?? ''),
    });

    const { jobId } = await createJob({
      userId: user.id,
      termId,
      files: prepared,
      pastedText,
      courseHint: body.courseHint?.trim() || null,
    });

    // Hand off after the response is flushed. Awaited, because an unawaited
    // fetch inside after() can be torn down before it is dispatched.
    after(async () => { await triggerWorker(jobId); });

    return json(
      {
        jobId,
        termId,
        totalFiles: prepared.length + (pastedText ? 1 : 0),
        rejectedFiles: rejected,
        quota: { used: quota.used + 1, limit: quota.limit, plan: quota.plan },
      },
      { status: 202 },
    );
  });
}

/** Reuses a term with the same name, so a second upload joins the first schedule. */
async function ensureTerm(
  userId: string,
  term: { name: string; timezone: string; startDate: string | null; endDate: string | null; meetingDays: number[] },
): Promise<string> {
  const supabase = createAdminClient();

  const { data: existing } = await supabase
    .from('terms')
    .select('id')
    .eq('user_id', userId)
    .ilike('name', term.name)
    .maybeSingle();

  if (existing) {
    await supabase
      .from('terms')
      .update({
        ...(term.startDate ? { start_date: term.startDate } : {}),
        ...(term.endDate ? { end_date: term.endDate } : {}),
        timezone: term.timezone,
      })
      .eq('id', existing.id);
    return existing.id;
  }

  const { data, error } = await supabase
    .from('terms')
    .insert({
      user_id: userId,
      name: term.name,
      timezone: term.timezone,
      start_date: term.startDate,
      end_date: term.endDate,
    })
    .select('id')
    .maybeSingle();

  if (error || !data) {
    logger.error('extract.term_create_failed', { message: error?.message });
    throw new AppError('internal', { context: { reason: 'could not create term' } });
  }
  return data.id;
}
