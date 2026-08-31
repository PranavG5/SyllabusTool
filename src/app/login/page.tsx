import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Header } from '@/components/Header';
import { getCurrentUser } from '@/lib/supabase/server';
import { SignInForm } from '@/components/SignInForm';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage() {
  const user = await getCurrentUser().catch(() => null);
  if (user) redirect('/input');

  return (
    <>
      <Header />
      <main id="main" className="mx-auto max-w-md px-4 py-12">
        <h1 className="text-2xl font-bold text-[var(--color-ink)]">Sign in</h1>
        <p className="mt-1 text-[var(--color-ink-soft)]">
          Your schedule is saved to your account so you can edit it later and keep your calendar in
          sync.
        </p>
        <div className="mt-6">
          <SignInForm />
        </div>
      </main>
    </>
  );
}
