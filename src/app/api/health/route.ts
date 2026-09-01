import { NextResponse } from 'next/server';
import { handle, json } from '@/lib/http';
import { createAdminClient } from '@/lib/supabase/server';
import { STORAGE_BUCKET } from '@/lib/jobs';
import { extractionModel } from '@/lib/extract/client';
import { errorFields, logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Checks every dependency the app needs and names whichever is broken.
 *
 * This exists because two separate outages here presented as the same vague
 * message. A migration guard silently skipped creating the storage bucket, and
 * uploads failed with "we could not save your upload" — nothing in that
 * sentence points at a missing bucket. One call to this route would have said
 * so immediately.
 *
 * Deliberately unauthenticated but deliberately contentless: it reports
 * whether each dependency works, never any value. No key, no URL, no row is
 * echoed, so it is safe to hit from anywhere and safe to paste into a bug
 * report.
 */

type CheckStatus = 'ok' | 'fail' | 'not_configured';

interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

function envCheck(name: string, label: string, validate?: (v: string) => string | null): Check {
  const value = process.env[name];
  if (!value) {
    return { name: label, status: 'not_configured', detail: `${name} is not set` };
  }
  const problem = validate?.(value);
  if (problem) return { name: label, status: 'fail', detail: problem };
  return { name: label, status: 'ok', detail: 'set' };
}

export async function GET(): Promise<NextResponse> {
  return handle('GET /api/health', async () => {
    const checks: Check[] = [];

    checks.push(envCheck('NEXT_PUBLIC_SUPABASE_URL', 'Supabase URL'));
    checks.push(envCheck('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'Supabase anon key'));
    checks.push(envCheck('SUPABASE_SERVICE_ROLE_KEY', 'Supabase service role key'));
    checks.push(envCheck('ANTHROPIC_API_KEY', 'Anthropic API key'));
    checks.push(envCheck('JOB_WORKER_SECRET', 'Background worker secret'));
    checks.push(
      envCheck('TOKEN_ENCRYPTION_KEY', 'Token encryption key', (v) => {
        const bytes = Buffer.from(v, 'base64').length;
        return bytes === 32 ? null : `must decode to 32 bytes, got ${bytes}`;
      }),
    );
    checks.push(
      envCheck('NEXT_PUBLIC_SITE_URL', 'Public site URL', (v) =>
        /^https?:\/\//.test(v) ? null : 'must start with http:// or https://',
      ),
    );

    // Database reachable, and the schema actually applied.
    try {
      const supabase = createAdminClient();
      const { error } = await supabase.from('plan_limits').select('plan').limit(1);
      checks.push(
        error
          ? { name: 'Database', status: 'fail', detail: `query failed: ${error.message.slice(0, 120)}` }
          : { name: 'Database', status: 'ok', detail: 'reachable, migrations applied' },
      );
    } catch (err) {
      checks.push({ name: 'Database', status: 'fail', detail: 'client could not be created' });
      logger.warn('health.db_failed', errorFields(err));
    }

    // The private bucket — the check that would have caught the last outage.
    try {
      const supabase = createAdminClient();
      const { data, error } = await supabase.storage.listBuckets();
      if (error) {
        checks.push({ name: 'Storage bucket', status: 'fail', detail: `could not list buckets: ${error.message.slice(0, 120)}` });
      } else if (!data?.some((b) => b.name === STORAGE_BUCKET)) {
        checks.push({
          name: 'Storage bucket',
          status: 'fail',
          detail: `the "${STORAGE_BUCKET}" bucket does not exist — file uploads will fail; pasting text still works`,
        });
      } else {
        const bucket = data.find((b) => b.name === STORAGE_BUCKET)!;
        checks.push({
          name: 'Storage bucket',
          status: bucket.public ? 'fail' : 'ok',
          detail: bucket.public
            ? 'the bucket is PUBLIC — uploaded syllabi would be world-readable'
            : 'present and private',
        });
      }
    } catch (err) {
      checks.push({ name: 'Storage bucket', status: 'fail', detail: 'storage client could not be created' });
      logger.warn('health.storage_failed', errorFields(err));
    }

    checks.push({ name: 'Extraction model', status: 'ok', detail: extractionModel() });
    checks.push({
      name: 'Google Calendar',
      status: process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? 'ok' : 'not_configured',
      detail: 'optional — .ics download and the feed work without it',
    });

    const failing = checks.filter((c) => c.status === 'fail');
    const status = failing.length > 0 ? 'degraded' : 'ok';

    return json(
      {
        status,
        summary:
          failing.length === 0
            ? 'Everything this app depends on is working.'
            : `${failing.length} problem(s): ${failing.map((c) => c.name).join(', ')}`,
        checks,
      },
      { status: failing.length > 0 ? 503 : 200 },
    );
  });
}
