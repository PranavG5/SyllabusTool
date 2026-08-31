import 'server-only';

/**
 * Background extraction jobs.
 *
 * Extraction against several files takes far longer than a request should
 * live, so the API creates a job row, returns immediately, and the UI polls.
 * The worker runs in its own invocation with a fresh timeout budget.
 *
 * There is no queue service: a job is a row, and `ensureJobRunning` re-triggers
 * a job that is still `queued` after a grace period. That makes the pipeline
 * self-healing if a trigger is dropped, without a Redis to operate.
 */

import { randomUUID } from 'node:crypto';
import { AppError } from '@/lib/errors';
import { logger, errorFields } from '@/lib/logger';
import { estimateCostUsd } from '@/lib/pricing';
import { createAdminClient } from '@/lib/supabase/server';
import { safeEqual, hashIdentifier } from '@/lib/crypto';
import { runExtraction, type PipelineSource } from '@/lib/extract/pipeline';
import { courseColorFor } from '@/lib/types';
import type { ParsedFile } from '@/lib/parse';
import type { ExtractionJobRow, UploadRow } from '@/lib/supabase/types';
import { siteUrl } from '@/lib/http';

export const STORAGE_BUCKET = 'syllabi';
/** A job still `queued` after this long is assumed to have lost its trigger. */
const REQUEUE_AFTER_MS = 15_000;
const MAX_ATTEMPTS = 3;

export interface CreateJobInput {
  userId: string;
  termId: string;
  files: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
    pageCount: number | null;
    parsed: ParsedFile;
    bytes: Uint8Array;
  }[];
  pastedText: string | null;
  courseHint: string | null;
}

export interface CreatedJob {
  jobId: string;
  uploadIds: string[];
}

/**
 * Creates the job and its upload rows. Files have already been parsed and
 * validated by the caller, so a job never exists for input we know is bad.
 */
export async function createJob(input: CreateJobInput): Promise<CreatedJob> {
  const supabase = createAdminClient();
  const jobId = randomUUID();

  const { error: jobError } = await supabase.from('extraction_jobs').insert({
    id: jobId,
    user_id: input.userId,
    term_id: input.termId,
    status: 'queued',
    total_files: input.files.length + (input.pastedText ? 1 : 0),
    course_hint: input.courseHint,
  });
  if (jobError) {
    logger.error('jobs.create_failed', { message: jobError.message });
    throw new AppError('internal', { context: { reason: 'could not create job' } });
  }

  const uploadIds: string[] = [];

  for (const file of input.files) {
    const uploadId = randomUUID();
    const storagePath = `${input.userId}/${jobId}/${uploadId}-${sanitizeFilename(file.filename)}`;

    // The original goes to a private bucket. Reads always use a short-lived
    // signed URL; the bucket has no public access and rows are purged after 30
    // days by the retention job.
    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, file.bytes, { contentType: file.mimeType, upsert: false });

    if (uploadError) {
      logger.warn('jobs.storage_upload_failed', { filename: file.filename, message: uploadError.message });
    }

    const { error } = await supabase.from('uploads').insert({
      id: uploadId,
      user_id: input.userId,
      job_id: jobId,
      storage_path: uploadError ? null : storagePath,
      filename: file.filename,
      mime_type: file.mimeType,
      size_bytes: file.sizeBytes,
      page_count: file.pageCount,
      status: 'parsed',
      // Working state only: cleared as soon as the job finishes.
      extracted_text: file.parsed.kind === 'text' ? file.parsed.text : null,
    });
    if (error) {
      logger.error('jobs.upload_row_failed', { message: error.message });
      throw new AppError('internal', { context: { reason: 'could not record upload' } });
    }
    uploadIds.push(uploadId);
  }

  if (input.pastedText) {
    const uploadId = randomUUID();
    const { error } = await supabase.from('uploads').insert({
      id: uploadId,
      user_id: input.userId,
      job_id: jobId,
      storage_path: null,
      filename: 'Pasted text',
      mime_type: 'text/plain',
      size_bytes: Buffer.byteLength(input.pastedText, 'utf8'),
      status: 'parsed',
      extracted_text: input.pastedText,
    });
    if (error) throw new AppError('internal', { context: { reason: 'could not record pasted text' } });
    uploadIds.push(uploadId);
  }

  logger.info('jobs.created', { jobId, userId: input.userId, files: input.files.length });
  return { jobId, uploadIds };
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file';
}

// ---------------------------------------------------------------------------
// Triggering
// ---------------------------------------------------------------------------

function workerSecret(): string {
  const secret = process.env.JOB_WORKER_SECRET;
  if (!secret) throw new Error('JOB_WORKER_SECRET is not configured');
  return secret;
}

export function isWorkerAuthorized(request: Request): boolean {
  const header = request.headers.get('x-job-worker-secret');
  if (!header) return false;
  try {
    return safeEqual(header, workerSecret());
  } catch {
    return false;
  }
}

/** Fire-and-forget trigger. Failure is survivable: the poll route re-triggers. */
export function triggerWorker(jobId: string): void {
  const url = `${siteUrl()}/api/jobs/${jobId}/process`;
  void fetch(url, {
    method: 'POST',
    headers: { 'x-job-worker-secret': workerSecret() },
    // Do not await the body; we only need the request to have been dispatched.
  }).catch((err) => {
    logger.warn('jobs.trigger_failed', { jobId, ...errorFields(err) });
  });
}

/**
 * Re-triggers a job that is still queued past the grace period. Called from
 * the poll endpoint, so a dropped trigger self-heals within one poll interval
 * instead of leaving the student staring at a spinner.
 */
export function maybeRequeue(job: ExtractionJobRow): void {
  if (job.status !== 'queued') return;
  if (job.attempts >= MAX_ATTEMPTS) return;
  if (Date.now() - new Date(job.created_at).getTime() < REQUEUE_AFTER_MS) return;
  logger.info('jobs.requeue', { jobId: job.id, attempts: job.attempts });
  triggerWorker(job.id);
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * Executes a job. Idempotent at the coarse level: a job already past `queued`
 * is left alone, so a duplicated trigger cannot double-charge or double-insert.
 */
export async function runJob(jobId: string): Promise<void> {
  const supabase = createAdminClient();
  const started = Date.now();

  const { data: job, error: jobError } = await supabase
    .from('extraction_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle();

  if (jobError || !job) throw new AppError('not_found');

  // Claim the job. The status filter makes this a compare-and-set: a second
  // trigger arriving concurrently updates zero rows and returns.
  const { data: claimed } = await supabase
    .from('extraction_jobs')
    .update({ status: 'running', started_at: new Date().toISOString(), attempts: job.attempts + 1 })
    .eq('id', jobId)
    .eq('status', 'queued')
    .select('id');

  if (!claimed || claimed.length === 0) {
    logger.info('jobs.already_claimed', { jobId, status: job.status });
    return;
  }

  try {
    const { data: uploads } = await supabase
      .from('uploads')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: true });

    const { data: term } = await supabase
      .from('terms')
      .select('*')
      .eq('id', job.term_id ?? '')
      .maybeSingle();

    const { data: courses } = await supabase
      .from('courses')
      .select('code, meeting_days')
      .eq('term_id', job.term_id ?? '');

    const meetingDaysByCourse: Record<string, number[]> = {};
    for (const c of courses ?? []) {
      meetingDaysByCourse[c.code.toLowerCase()] = c.meeting_days ?? [];
    }

    const sources = await loadSources(uploads ?? []);

    const result = await runExtraction({
      sources: sources.sources,
      pastedText: null, // pasted text arrives as an upload row like any other source
      termName: term?.name ?? null,
      termStartDate: term?.start_date ?? null,
      termEndDate: term?.end_date ?? null,
      courseHint: job.course_hint,
      meetingDaysByCourse,
      defaultMeetingDays: [],
    });

    const fileErrors = [...sources.errors, ...result.fileErrors];
    const itemCount = await persistItems(job.user_id, job.term_id!, result.items);

    await supabase
      .from('extraction_jobs')
      .update({
        status: fileErrors.length > 0 ? 'partial' : 'succeeded',
        processed_files: job.total_files - fileErrors.length,
        file_errors: fileErrors,
        item_count: itemCount,
        finished_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    await supabase.from('usage_events').insert({
      user_id: job.user_id,
      job_id: jobId,
      kind: 'extraction',
      model: result.model,
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      cache_read_tokens: result.usage.cacheReadTokens,
      cache_write_tokens: result.usage.cacheWriteTokens,
      cost_usd: estimateCostUsd(result.model, result.usage),
      files_count: job.total_files,
      chunks_count: result.chunkCount,
      duration_ms: Date.now() - started,
      succeeded: true,
    });

    // Full document text was working state. From here on the only extracted
    // text we keep is items.source_snippet.
    await supabase.rpc('purge_job_text', { p_job_id: jobId });

    logger.info('jobs.finished', {
      jobId, items: itemCount, failed: fileErrors.length, durationMs: Date.now() - started,
    });
  } catch (err) {
    const message =
      err instanceof AppError ? err.userMessage : "We couldn't finish reading your syllabus.";
    await supabase
      .from('extraction_jobs')
      .update({ status: 'failed', error_message: message, finished_at: new Date().toISOString() })
      .eq('id', jobId);
    await supabase.from('usage_events').insert({
      user_id: job.user_id, job_id: jobId, kind: 'extraction',
      duration_ms: Date.now() - started, succeeded: false,
    });
    await supabase.rpc('purge_job_text', { p_job_id: jobId });
    logger.error('jobs.failed', { jobId, ...errorFields(err) });
  }
}

/** Rebuilds ParsedFile inputs from upload rows, fetching blobs only for vision. */
async function loadSources(
  uploads: UploadRow[],
): Promise<{ sources: PipelineSource[]; errors: { filename: string; reason: string }[] }> {
  const supabase = createAdminClient();
  const sources: PipelineSource[] = [];
  const errors: { filename: string; reason: string }[] = [];

  for (const upload of uploads) {
    if (upload.extracted_text) {
      sources.push({
        uploadId: upload.id,
        parsed: {
          kind: 'text', filename: upload.filename, text: upload.extracted_text,
          base64: null, mediaType: null, pageCount: upload.page_count,
        },
      });
      continue;
    }

    if (!upload.storage_path) {
      errors.push({ filename: upload.filename, reason: 'The file was not saved, so we could not read it.' });
      continue;
    }

    const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(upload.storage_path);
    if (error || !data) {
      errors.push({ filename: upload.filename, reason: 'We could not open the saved copy of this file.' });
      continue;
    }

    const bytes = Buffer.from(await data.arrayBuffer());
    const isPdf = upload.mime_type === 'application/pdf';
    sources.push({
      uploadId: upload.id,
      parsed: {
        kind: isPdf ? 'pdf-scan' : 'image',
        filename: upload.filename,
        text: '',
        base64: bytes.toString('base64'),
        mediaType: isPdf ? null : (upload.mime_type as 'image/png' | 'image/jpeg' | 'image/webp'),
        pageCount: upload.page_count,
      },
    });
  }

  return { sources, errors };
}

/** Creates courses on demand and inserts items, skipping ones already present. */
async function persistItems(
  userId: string,
  termId: string,
  items: Awaited<ReturnType<typeof runExtraction>>['items'],
): Promise<number> {
  const supabase = createAdminClient();

  const { data: existingCourses } = await supabase
    .from('courses')
    .select('id, code')
    .eq('term_id', termId);

  const courseIdByCode = new Map<string, string>();
  for (const c of existingCourses ?? []) courseIdByCode.set(c.code.toLowerCase(), c.id);
  let colorIndex = existingCourses?.length ?? 0;

  for (const item of items) {
    const codeKey = item.courseCode.toLowerCase();
    if (courseIdByCode.has(codeKey)) continue;
    const { data, error } = await supabase
      .from('courses')
      .insert({
        user_id: userId, term_id: termId, code: item.courseCode,
        name: item.courseName, color: courseColorFor(colorIndex), position: colorIndex,
      })
      .select('id')
      .maybeSingle();
    if (error) {
      // Another concurrent job may have created it; re-read rather than fail.
      const { data: found } = await supabase
        .from('courses').select('id').eq('term_id', termId).ilike('code', item.courseCode).maybeSingle();
      if (found) courseIdByCode.set(codeKey, found.id);
      continue;
    }
    if (data) {
      courseIdByCode.set(codeKey, data.id);
      colorIndex += 1;
    }
  }

  // Skip items already stored for this course under the same dedupe key, so a
  // student who uploads the same syllabus twice does not get two calendars.
  const { data: existingItems } = await supabase
    .from('items')
    .select('course_id, dedupe_key')
    .eq('term_id', termId)
    .not('dedupe_key', 'is', null);
  const seen = new Set((existingItems ?? []).map((i) => `${i.course_id}|${i.dedupe_key}`));

  const rows = items
    .map((item) => {
      const courseId = courseIdByCode.get(item.courseCode.toLowerCase());
      if (!courseId) return null;
      if (seen.has(`${courseId}|${item.dedupeKey}`)) return null;
      seen.add(`${courseId}|${item.dedupeKey}`);
      return {
        user_id: userId,
        term_id: termId,
        course_id: courseId,
        title: item.title,
        type: item.type,
        due_date: item.dueDate,
        due_time: item.dueTime,
        time_is_default: item.timeIsDefault,
        weight: item.weight,
        location: item.location,
        source_snippet: item.sourceSnippet,
        source_upload_id: item.sourceUploadId,
        confidence: item.confidence,
        dedupe_key: item.dedupeKey,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (rows.length === 0) return 0;

  const { error } = await supabase.from('items').insert(rows);
  if (error) {
    logger.error('jobs.item_insert_failed', { message: error.message });
    throw new AppError('internal', { context: { reason: 'could not save extracted items' } });
  }
  return rows.length;
}

export { hashIdentifier };
