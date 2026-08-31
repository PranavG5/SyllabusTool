import { NextResponse, after } from 'next/server';
import { AppError } from '@/lib/errors';
import { handle, json, requireUser } from '@/lib/http';
import { consumeExtractionQuota } from '@/lib/quota';
import { parseFile, type ParsedFile } from '@/lib/parse';
import { createJob, triggerWorker } from '@/lib/jobs';
import { createAdminClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { parseMeetingDays } from '@/lib/schedule/relative-dates';
import { isValidTimeZone, parseISODate } from '@/lib/datetime';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Starts a schedule build.
 *
 * Order matters and is deliberate:
 *   1. Quota first, so an over-limit user is refused before any work.
 *   2. Parse every file synchronously, so an encrypted PDF or a 300-page
 *      course pack is rejected with a clear message and costs nothing.
 *   3. Only then create the job and hand off to the background worker.
 *
 * The response returns as soon as the job row exists; the UI polls
 * /api/jobs/[id] from there.
 */

const MAX_PASTED_CHARS = 400_000;

export async function POST(request: Request): Promise<NextResponse> {
  return handle('POST /api/extract', async () => {
    const user = await requireUser();

    const form = await request.formData().catch(() => null);
    if (!form) throw new AppError('invalid_input');

    const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
    const pastedText = (form.get('text') as string | null)?.trim() || null;
    const courseHint = (form.get('courseHint') as string | null)?.trim() || null;
    const termName = (form.get('termName') as string | null)?.trim() || 'My term';
    const termStartDate = (form.get('termStartDate') as string | null)?.trim() || null;
    const termEndDate = (form.get('termEndDate') as string | null)?.trim() || null;
    const meetingDaysRaw = (form.get('meetingDays') as string | null)?.trim() || '';
    const timezone = (form.get('timezone') as string | null)?.trim() || 'America/New_York';

    if (files.length === 0 && !pastedText) throw new AppError('no_input');
    if (pastedText && pastedText.length > MAX_PASTED_CHARS) {
      throw new AppError('input_too_long', {
        userMessage: `That is ${pastedText.length.toLocaleString()} characters; we read up to ${MAX_PASTED_CHARS.toLocaleString()} in one go.`,
      });
    }
    if (termStartDate && !parseISODate(termStartDate)) {
      throw new AppError('invalid_input', {
        userMessage: 'That term start date was not a real date.',
        nextAction: 'Pick the first day of classes and try again.',
      });
    }

    // 1. Quota. Throws when refused, so nothing below runs for an over-limit user.
    const quota = await consumeExtractionQuota(user.id, files.length + (pastedText ? 1 : 0));

    // 2. Parse and validate every file up front.
    const prepared: {
      filename: string; mimeType: string; sizeBytes: number;
      pageCount: number | null; parsed: ParsedFile; bytes: Uint8Array;
    }[] = [];
    const rejected: { filename: string; reason: string }[] = [];

    for (const file of files) {
      if (file.size > quota.limits.maxFileBytes) {
        rejected.push({
          filename: file.name,
          reason: `This file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${Math.round(quota.limits.maxFileBytes / 1024 / 1024)} MB.`,
        });
        continue;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        const parsed = await parseFile({
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          bytes,
          maxPdfPages: quota.limits.maxPdfPages,
        });
        prepared.push({
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
          pageCount: parsed.pageCount,
          parsed,
          bytes,
        });
      } catch (err) {
        rejected.push({
          filename: file.name,
          reason: err instanceof AppError ? err.userMessage : 'We could not read this file.',
        });
      }
    }

    if (prepared.length === 0 && !pastedText) {
      throw new AppError('unparseable_file', {
        userMessage:
          rejected.length === 1
            ? rejected[0]!.reason
            : 'None of those files could be read.',
        nextAction: 'Try a different format, or paste the schedule text instead.',
        context: { rejected },
      });
    }

    // 3. Make sure there is a term to hang the schedule off.
    const termId = await ensureTerm(user.id, {
      name: termName,
      timezone: isValidTimeZone(timezone) ? timezone : 'America/New_York',
      startDate: termStartDate,
      endDate: termEndDate,
      meetingDays: parseMeetingDays(meetingDaysRaw),
    });

    const { jobId } = await createJob({
      userId: user.id,
      termId,
      files: prepared,
      pastedText,
      courseHint,
    });

    // Hand off after the response is flushed, so the student is not waiting on
    // the model. Awaited, because an unawaited fetch inside after() can be torn
    // down before it is dispatched. The poll endpoint re-triggers if it still
    // never lands.
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
    // Later uploads may supply dates the first one lacked.
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
