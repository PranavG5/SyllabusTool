import { NextResponse } from 'next/server';
import { handle, json, requireUser } from '@/lib/http';
import { revokeGoogleAccess } from '@/lib/google/calendar';

export const runtime = 'nodejs';

/** Revokes at Google and deletes our stored tokens. */
export async function POST(): Promise<NextResponse> {
  return handle('POST /api/google/disconnect', async () => {
    const user = await requireUser();
    await revokeGoogleAccess(user.id);
    return json({ disconnected: true });
  });
}
