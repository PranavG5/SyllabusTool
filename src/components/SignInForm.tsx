'use client';

import { useId, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import { ErrorNotice } from '@/components/ErrorNotice';

/** Email magic link and Google. No passwords to lose or leak. */
export function SignInForm() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const emailId = useId();

  const redirectTo = typeof window === 'undefined' ? undefined : `${window.location.origin}/auth/callback`;

  async function sendMagicLink(event: React.FormEvent) {
    event.preventDefault();
    setState('sending');
    setError(null);
    try {
      const { error: authError } = await getSupabaseBrowserClient().auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo },
      });
      if (authError) throw authError;
      setState('sent');
    } catch (err) {
      setState('idle');
      setError(err instanceof Error ? err.message : 'We could not send that link.');
    }
  }

  async function signInWithGoogle() {
    setError(null);
    try {
      const { error: authError } = await getSupabaseBrowserClient().auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo },
      });
      if (authError) throw authError;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We could not start Google sign-in.');
    }
  }

  if (state === 'sent') {
    return (
      <div role="status" className="card bg-[var(--color-good-soft)] p-5">
        <h2 className="font-semibold text-[var(--color-good)]">Check your email</h2>
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
          We sent a sign-in link to <strong>{email}</strong>. It expires in an hour.
        </p>
        <button type="button" className="btn btn-ghost mt-3" onClick={() => setState('idle')}>
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <form onSubmit={sendMagicLink} className="card space-y-3 p-5">
        <div>
          <label htmlFor={emailId} className="label">
            Email address
          </label>
          <input
            id={emailId}
            type="email"
            required
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="field"
            placeholder="you@university.edu"
          />
        </div>
        <button type="submit" disabled={state === 'sending' || !email} className="btn btn-primary w-full">
          {state === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
        </button>
      </form>

      <div className="flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-[var(--color-line)]" />
        <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-ink-faint)]">or</span>
        <span className="h-px flex-1 bg-[var(--color-line)]" />
      </div>

      <button type="button" onClick={signInWithGoogle} className="btn btn-secondary w-full">
        Continue with Google
      </button>

      {error ? <ErrorNotice message={error} nextAction="Check the address and try again." /> : null}
    </div>
  );
}
