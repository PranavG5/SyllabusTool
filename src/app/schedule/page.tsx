import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { ScheduleView } from '@/components/schedule/ScheduleView';
import { ExportPanel } from '@/components/schedule/ExportPanel';
import { createServerClient, createAdminClient, getCurrentUser } from '@/lib/supabase/server';
import { loadSchedule } from '@/lib/schedule/load';
import { googleConfigured } from '@/lib/google/calendar';
import { siteUrl } from '@/lib/http';

export const metadata: Metadata = { title: 'My schedule' };
export const dynamic = 'force-dynamic';

const GOOGLE_STATUS: Record<string, { tone: 'good' | 'bad'; message: string }> = {
  connected: { tone: 'good', message: 'Google Calendar connected. Press Send to write your schedule across.' },
  declined: { tone: 'bad', message: 'You declined the Google permission, so nothing was connected.' },
  state_mismatch: { tone: 'bad', message: 'That connection attempt expired. Please start it again.' },
  signed_out: { tone: 'bad', message: 'You were signed out during the connection. Sign in and try again.' },
  no_refresh_token: { tone: 'bad', message: 'Google did not return a lasting permission. Try connecting again and accept every prompt.' },
  scope_missing: { tone: 'bad', message: 'The calendar permission was not granted, so we cannot create a calendar.' },
  failed: { tone: 'bad', message: 'Something went wrong connecting Google Calendar. Please try again.' },
};

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ termId?: string; google?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const { termId, google: googleStatus } = await searchParams;
  const supabase = await createServerClient();
  const payload = await loadSchedule(supabase, termId ?? null);

  const admin = createAdminClient();
  const [{ data: profile }, { data: connection }] = await Promise.all([
    admin.from('users').select('feed_token').eq('id', user.id).maybeSingle(),
    admin
      .from('calendar_connections')
      .select('calendar_name, last_synced_at')
      .eq('user_id', user.id)
      .maybeSingle(),
  ]);

  const notice = googleStatus ? GOOGLE_STATUS[googleStatus] : undefined;

  if (!payload) {
    return (
      <>
        <Header action={<Link href="/input" className="btn btn-primary">Add your syllabus</Link>} />
        <main id="main" className="mx-auto max-w-5xl px-4 py-12">
          <h1 className="text-2xl font-bold text-[var(--color-ink)]">No schedule yet</h1>
          <p className="mt-1 text-[var(--color-ink-soft)]">
            Add a syllabus and every deadline in it lands here.
          </p>
          <Link href="/input" className="btn btn-primary mt-5">Add your syllabus</Link>
        </main>
      </>
    );
  }

  const activeCount = payload.items.filter((i) => i.status === 'active').length;

  return (
    <>
      <Header action={<Link href="/input" className="btn btn-secondary">Add more</Link>} />
      <main id="main" className="mx-auto max-w-5xl px-4 py-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h1 className="text-2xl font-bold text-[var(--color-ink)]">{payload.term.name}</h1>
            <p className="text-[var(--color-ink-soft)]">
              {activeCount} item{activeCount === 1 ? '' : 's'} across {payload.courses.length} course
              {payload.courses.length === 1 ? '' : 's'} · specific times shown in{' '}
              {payload.term.timezone.replace('_', ' ')}
            </p>
          </div>
          <Link href={`/review?termId=${payload.term.id}`} className="btn btn-secondary">
            Edit items
          </Link>
        </div>

        {notice ? (
          <p
            role="status"
            className={`card mt-4 p-3 text-sm ${
              notice.tone === 'good'
                ? 'bg-[var(--color-good-soft)] text-[var(--color-good)]'
                : 'bg-[var(--color-flag-soft)] text-[var(--color-flag)]'
            }`}
          >
            {notice.message}
          </p>
        ) : null}

        <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_320px]">
          <div>
            <ScheduleView payload={payload} />
          </div>
          <aside aria-label="Export">
            <ExportPanel
              termId={payload.term.id}
              feedUrl={profile?.feed_token ? `${siteUrl()}/api/feed/${profile.feed_token}.ics` : null}
              google={{
                connected: Boolean(connection),
                calendarName: connection?.calendar_name ?? null,
                lastSyncedAt: connection?.last_synced_at ?? null,
              }}
              googleAvailable={googleConfigured()}
            />
            <p className="mt-4 text-center">
              <Link href="/account" className="text-sm text-[var(--color-accent)] hover:underline">
                Account settings
              </Link>
            </p>
          </aside>
        </div>
      </main>
    </>
  );
}
