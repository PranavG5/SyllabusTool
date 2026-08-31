import { NextResponse } from 'next/server';
import { handle, json, requireUser } from '@/lib/http';
import { createServerClient } from '@/lib/supabase/server';
import { AppError } from '@/lib/errors';
import { loadSchedule } from '@/lib/schedule/load';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Everything the review and schedule screens render, in one round trip. */
export async function GET(request: Request): Promise<NextResponse> {
  return handle('GET /api/schedule', async () => {
    await requireUser();
    const termId = new URL(request.url).searchParams.get('termId');
    // Reads go through the user's own client, so RLS is the thing enforcing
    // access here rather than a WHERE clause we could forget to write.
    const supabase = await createServerClient();
    const payload = await loadSchedule(supabase, termId);
    if (!payload) throw new AppError('not_found');
    return json(payload);
  });
}
