import { NextResponse } from 'next/server';
import { AppError } from '@/lib/errors';
import { handle, json, requireUser, siteUrl } from '@/lib/http';
import { createServerClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

/**
 * Rotates the feed token, invalidating a URL the student has shared or leaked.
 * The SQL function is self-scoped to auth.uid(), so this cannot rotate anyone
 * else's token even though it runs security-definer.
 */
export async function POST(): Promise<NextResponse> {
  return handle('POST /api/feed/rotate', async () => {
    await requireUser();
    const supabase = await createServerClient();
    const { data, error } = await supabase.rpc('rotate_feed_token');
    if (error || typeof data !== 'string') {
      throw new AppError('internal', { cause: error, context: { reason: 'feed rotate failed' } });
    }
    return json({ feedUrl: `${siteUrl()}/api/feed/${data}.ics` });
  });
}
