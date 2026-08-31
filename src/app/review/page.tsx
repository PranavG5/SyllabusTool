import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { ReviewTable } from '@/components/review/ReviewTable';
import { createServerClient, getCurrentUser } from '@/lib/supabase/server';
import { loadSchedule } from '@/lib/schedule/load';
import { createAdminClient } from '@/lib/supabase/server';

export const metadata: Metadata = { title: 'Review what we found' };
export const dynamic = 'force-dynamic';

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ termId?: string; jobId?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const { termId, jobId } = await searchParams;
  const supabase = await createServerClient();
  const payload = await loadSchedule(supabase, termId ?? null);

  if (!payload) {
    return (
      <>
        <Header />
        <main id="main" className="mx-auto max-w-3xl px-4 py-12">
          <h1 className="text-2xl font-bold text-[var(--color-ink)]">Nothing to review yet</h1>
          <p className="mt-1 text-[var(--color-ink-soft)]">Add a syllabus and we will pull out the deadlines.</p>
          <Link href="/input" className="btn btn-primary mt-5">Add your syllabus</Link>
        </main>
      </>
    );
  }

  // Surface per-file failures from the job that produced this batch, so a
  // student knows which upload did not make it rather than silently missing it.
  let fileErrors: { filename: string; reason: string }[] = [];
  if (jobId) {
    const { data: job } = await createAdminClient()
      .from('extraction_jobs')
      .select('file_errors')
      .eq('id', jobId)
      .eq('user_id', user.id)
      .maybeSingle();
    fileErrors = job?.file_errors ?? [];
  }

  return (
    <>
      <Header action={<Link href="/input" className="btn btn-secondary">Add more</Link>} />
      <main id="main" className="mx-auto max-w-5xl px-4 py-8">
        <h1 className="text-2xl font-bold text-[var(--color-ink)]">Review what we found</h1>
        <p className="mt-1 text-[var(--color-ink-soft)]">
          Fix anything that looks wrong, then confirm. Nothing reaches your calendar until you do.
        </p>

        {fileErrors.length > 0 ? (
          <div
            role="alert"
            className="card mt-5 border-[var(--color-flag-line)] bg-[var(--color-flag-soft)] p-4"
          >
            <p className="font-semibold text-[var(--color-flag)]">
              {fileErrors.length} file{fileErrors.length === 1 ? '' : 's'} could not be read. Everything
              else came through.
            </p>
            <ul className="mt-2 space-y-1 text-sm text-[var(--color-ink-soft)]">
              {fileErrors.map((e) => (
                <li key={e.filename}>
                  <strong className="font-medium text-[var(--color-ink)]">{e.filename}</strong> — {e.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-6">
          <ReviewTable initial={payload} />
        </div>
      </main>
    </>
  );
}
