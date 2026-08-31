import { NextResponse, after } from 'next/server';
import { handle, json } from '@/lib/http';
import { isWorkerAuthorized, runJob } from '@/lib/jobs';
import { AppError } from '@/lib/errors';
import { logger, errorFields } from '@/lib/logger';

export const runtime = 'nodejs';
/**
 * Extraction against several files takes minutes. This route runs in its own
 * invocation with a full timeout budget, which is the whole reason the work
 * does not happen inside POST /api/extract.
 */
export const maxDuration = 300;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return handle('POST /api/jobs/[id]/process', async () => {
    // Internal-only: authenticated by a shared secret, not a user session.
    if (!isWorkerAuthorized(request)) throw new AppError('unauthorized');
    const { id } = await params;

    // Acknowledge straight away so the caller's `after()` is not holding its
    // own invocation open for the length of the extraction. The work happens
    // here, in this invocation's own 300-second budget.
    after(async () => {
      try {
        await runJob(id);
      } catch (err) {
        // runJob already records the failure on the job row; this is the
        // last-resort log for something thrown outside that handling.
        logger.error('worker.unhandled', { jobId: id, ...errorFields(err) });
      }
    });

    return json({ accepted: true }, { status: 202 });
  });
}
