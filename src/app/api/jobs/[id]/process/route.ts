import { NextResponse } from 'next/server';
import { handle, json } from '@/lib/http';
import { isWorkerAuthorized, runJob } from '@/lib/jobs';
import { AppError } from '@/lib/errors';

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
    await runJob(id);
    return json({ ok: true });
  });
}
