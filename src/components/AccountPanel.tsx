'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ErrorNotice } from '@/components/ErrorNotice';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';

export function AccountPanel({
  initialFeedUrl,
  quota,
}: {
  initialFeedUrl: string | null;
  quota: { used: number; limit: number; remaining: number };
}) {
  const router = useRouter();
  const [feedUrl, setFeedUrl] = useState(initialFeedUrl);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState<'rotate' | 'delete' | null>(null);
  const [error, setError] = useState<{ message: string; nextAction?: string } | null>(null);
  const [rotated, setRotated] = useState(false);

  async function rotate() {
    setBusy('rotate');
    setError(null);
    try {
      const response = await fetch('/api/feed/rotate', { method: 'POST' });
      const body = await response.json();
      if (!response.ok) {
        setError({ message: body?.error?.message ?? 'That did not work.', nextAction: body?.error?.nextAction });
        return;
      }
      setFeedUrl(body.feedUrl);
      setRotated(true);
    } finally {
      setBusy(null);
    }
  }

  async function deleteAccount() {
    setBusy('delete');
    setError(null);
    try {
      const response = await fetch('/api/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'DELETE' }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError({
          message: body?.error?.message ?? 'We could not delete your account.',
          nextAction: body?.error?.nextAction ?? 'Try again, or email support.',
        });
        return;
      }
      await getSupabaseBrowserClient().auth.signOut();
      router.push('/?deleted=1');
    } catch {
      setError({ message: 'We could not reach the server.', nextAction: 'Try again in a moment.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <section className="card p-4">
        <h2 className="font-semibold text-[var(--color-ink)]">This month&apos;s usage</h2>
        <p className="mt-1 text-[var(--color-ink-soft)]">
          {quota.used} of {quota.limit} schedule builds used. Editing and exporting an existing
          schedule is always free.
        </p>
        <div
          className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--color-surface-2)]"
          role="img"
          aria-label={`${quota.used} of ${quota.limit} builds used`}
        >
          <div
            className="h-full rounded-full bg-[var(--color-accent)]"
            style={{ width: `${Math.min(100, (quota.used / Math.max(quota.limit, 1)) * 100)}%` }}
          />
        </div>
      </section>

      {feedUrl ? (
        <section className="card p-4">
          <h2 className="font-semibold text-[var(--color-ink)]">Calendar feed address</h2>
          <p className="hint mt-0.5">
            Anyone with this address can read your schedule. Replace it if you have shared it by
            accident — the old address stops working immediately.
          </p>
          <p className="mt-3 break-all rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-2 font-mono text-xs text-[var(--color-ink-soft)]">
            {feedUrl}
          </p>
          <button type="button" onClick={rotate} disabled={busy !== null} className="btn btn-secondary mt-3">
            {busy === 'rotate' ? 'Replacing…' : 'Replace this address'}
          </button>
          {rotated ? (
            <p role="status" className="mt-2 text-sm font-medium text-[var(--color-good)]">
              Replaced. Update any calendar app you had subscribed.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="card border-[var(--color-danger)] p-4">
        <h2 className="font-semibold text-[var(--color-danger)]">Delete your account</h2>
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
          This permanently removes your uploaded files, your schedule, your calendar feed, and any
          Google Calendar permission you granted. Events already written into your Google calendar
          stay there — delete that calendar in Google to remove them. This cannot be undone.
        </p>

        <label htmlFor="confirm-delete" className="label mt-4">
          Type DELETE to confirm
        </label>
        <input
          id="confirm-delete"
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          className="field max-w-xs"
          autoComplete="off"
        />
        <button
          type="button"
          onClick={deleteAccount}
          disabled={confirmText !== 'DELETE' || busy !== null}
          className="btn mt-3 bg-[var(--color-danger)] text-white hover:brightness-110 disabled:hover:brightness-100"
        >
          {busy === 'delete' ? 'Deleting…' : 'Delete my account'}
        </button>
      </section>

      {error ? <ErrorNotice message={error.message} nextAction={error.nextAction} /> : null}
    </div>
  );
}
