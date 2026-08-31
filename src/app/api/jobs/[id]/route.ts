import { NextResponse } from 'next/server';
import { AppError } from '@/lib/errors';
import { after } from 'next/server';
import { handle, json, requireUser } from '@/lib/http';
import { createAdminClient } from '@/lib/supabase/server';
import { maybeRequeue, triggerWorker } from '@/lib/jobs';
import type { JobState } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Poll target for the input screen's progress state. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return handle('GET /api/jobs/[id]', async () => {
    const user = await requireUser();
    const { id } = await params;

    const { data: job } = await createAdminClient()
      .from('extraction_jobs')
      .select('*')
      .eq('id', id)
      .eq('user_id', user.id) // service role bypasses RLS, so scope explicitly
      .maybeSingle();

    if (!job) throw new AppError('not_found');

    // A job whose trigger was dropped restarts itself on the next poll.
    if (maybeRequeue(job)) after(() => triggerWorker(job.id));

    const state: JobState = {
      id: job.id,
      status: job.status,
      totalFiles: job.total_files,
      processedFiles: job.processed_files,
      itemCount: job.item_count,
      fileErrors: job.file_errors ?? [],
      errorMessage: job.error_message,
      termId: job.term_id,
    };
    return json(state);
  });
}
