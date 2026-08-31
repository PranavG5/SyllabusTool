import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { BuildForm } from '@/components/input/BuildForm';
import { getCurrentUser } from '@/lib/supabase/server';
import { getQuotaStatus } from '@/lib/quota';

export const metadata: Metadata = { title: 'Add your syllabus' };
export const dynamic = 'force-dynamic';

/** Guesses a term name from the date, so the field is prefilled not blank. */
function currentTermName(now = new Date()): string {
  const month = now.getUTCMonth() + 1;
  const year = now.getUTCFullYear();
  if (month >= 8) return `Fall ${year}`;
  if (month >= 5) return `Summer ${year}`;
  return `Spring ${year}`;
}

export default async function InputPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const quota = await getQuotaStatus(user.id);

  return (
    <>
      <Header
        action={
          <Link href="/schedule" className="btn btn-secondary">
            My schedule
          </Link>
        }
      />
      <main id="main" className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-2xl font-bold text-[var(--color-ink)]">Add your syllabus</h1>
        <p className="mt-1 text-[var(--color-ink-soft)]">
          Upload files, paste text, or both. We will pull out every deadline and show you what we
          found before anything reaches your calendar.
        </p>

        <div className="mt-6">
          <BuildForm
            limits={{
              maxFilesPerBatch: quota.limits.maxFilesPerBatch,
              maxFileBytes: quota.limits.maxFileBytes,
              maxInputChars: quota.limits.maxInputChars,
            }}
            quota={{ used: quota.used, limit: quota.limit, remaining: quota.remaining }}
            defaultTermName={currentTermName()}
            defaultTimezone="America/New_York"
          />
        </div>
      </main>
    </>
  );
}
