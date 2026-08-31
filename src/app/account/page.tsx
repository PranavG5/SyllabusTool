import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { AccountPanel } from '@/components/AccountPanel';
import { createAdminClient, getCurrentUser } from '@/lib/supabase/server';
import { getQuotaStatus } from '@/lib/quota';
import { siteUrl } from '@/lib/http';

export const metadata: Metadata = { title: 'Account' };
export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const [{ data: profile }, quota] = await Promise.all([
    createAdminClient().from('users').select('feed_token, plan').eq('id', user.id).maybeSingle(),
    getQuotaStatus(user.id),
  ]);

  return (
    <>
      <Header action={<Link href="/schedule" className="btn btn-secondary">My schedule</Link>} />
      <main id="main" className="mx-auto max-w-2xl px-4 py-8">
        <h1 className="text-2xl font-bold text-[var(--color-ink)]">Account</h1>
        <p className="mt-1 text-[var(--color-ink-soft)]">
          {user.email} · {profile?.plan ?? 'free'} plan
        </p>

        <div className="mt-6">
          <AccountPanel
            initialFeedUrl={profile?.feed_token ? `${siteUrl()}/api/feed/${profile.feed_token}.ics` : null}
            quota={{ used: quota.used, limit: quota.limit, remaining: quota.remaining }}
          />
        </div>
      </main>
    </>
  );
}
