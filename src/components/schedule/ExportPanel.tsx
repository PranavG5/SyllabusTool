'use client';

import { useState } from 'react';
import { ErrorNotice } from '@/components/ErrorNotice';

/**
 * The three export paths, in the order they matter:
 *   1. Download .ics — works everywhere, no permissions.
 *   2. Subscribe — the reason people keep using this, since edits stay in sync.
 *   3. Google Calendar — convenient, but needs OAuth, so it is last.
 */

export function ExportPanel({
  termId,
  feedUrl,
  google,
  googleAvailable,
}: {
  termId: string;
  feedUrl: string | null;
  google: { connected: boolean; calendarName: string | null; lastSyncedAt: string | null };
  googleAvailable: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; nextAction?: string } | null>(null);

  const webcalUrl = feedUrl ? feedUrl.replace(/^https?:/, 'webcal:') : null;

  async function copyFeed() {
    if (!feedUrl) return;
    try {
      await navigator.clipboard.writeText(feedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError({
        message: 'Your browser would not let us copy that.',
        nextAction: 'Select the link text and copy it manually.',
      });
    }
  }

  async function syncGoogle() {
    setSyncing(true);
    setError(null);
    setSyncResult(null);
    try {
      const response = await fetch(`/api/google/sync?termId=${termId}`, { method: 'POST' });
      const body = await response.json();
      if (!response.ok) {
        setError({ message: body?.error?.message ?? 'That did not work.', nextAction: body?.error?.nextAction });
        return;
      }
      setSyncResult(
        `${body.written} event${body.written === 1 ? '' : 's'} written to "${body.calendarName}".` +
          (body.skipped > 0 ? ` ${body.skipped} skipped — those have no date yet.` : ''),
      );
    } catch {
      setError({ message: 'We could not reach the server.', nextAction: 'Try again in a moment.' });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="card p-4">
        <h2 className="font-semibold text-[var(--color-ink)]">Download a calendar file</h2>
        <p className="hint mt-0.5">
          A one-off .ics that imports into Google Calendar, Apple Calendar, and Outlook.
        </p>
        <a href={`/api/export/ics?termId=${termId}`} className="btn btn-primary mt-3" download>
          Download .ics
        </a>
      </section>

      {feedUrl ? (
        <section className="card p-4">
          <h2 className="font-semibold text-[var(--color-ink)]">Subscribe (stays in sync)</h2>
          <p className="hint mt-0.5">
            Add this address to your calendar app once. When you edit an item here, your calendar
            updates on its own — no re-importing.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {webcalUrl ? (
              <a href={webcalUrl} className="btn btn-secondary">
                Add to my calendar app
              </a>
            ) : null}
            <button type="button" onClick={copyFeed} className="btn btn-secondary">
              {copied ? 'Copied' : 'Copy address'}
            </button>
          </div>

          <p className="mt-3 break-all rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-2 font-mono text-xs text-[var(--color-ink-soft)]">
            {feedUrl}
          </p>
          <p className="hint mt-2">
            Treat this address like a password — anyone who has it can read your schedule. You can
            replace it from your account page if you ever share it by accident.
          </p>
        </section>
      ) : null}

      <section className="card p-4">
        <h2 className="font-semibold text-[var(--color-ink)]">Add to Google Calendar</h2>
        {!googleAvailable ? (
          <p className="hint mt-0.5">
            Not configured on this deployment. Download the .ics file or subscribe above.
          </p>
        ) : google.connected ? (
          <>
            <p className="hint mt-0.5">
              Connected. We write only to <strong>{google.calendarName ?? 'a calendar we created'}</strong>,
              a separate calendar you can hide or delete in one action. We cannot see or change your
              other calendars.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={syncGoogle} disabled={syncing} className="btn btn-primary">
                {syncing ? 'Syncing…' : google.lastSyncedAt ? 'Sync again' : 'Send to Google Calendar'}
              </button>
              <form action="/api/google/disconnect" method="post">
                <button type="submit" className="btn btn-secondary">Disconnect</button>
              </form>
            </div>
            {syncResult ? (
              <p role="status" className="mt-3 text-sm font-medium text-[var(--color-good)]">
                {syncResult}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p className="hint mt-0.5">
              We create a new calendar named after your term and write only there. We ask for the
              narrowest permission Google offers, which cannot read or change your existing calendars.
            </p>
            <a href="/api/google/start" className="btn btn-secondary mt-3">
              Connect Google Calendar
            </a>
          </>
        )}
      </section>

      {error ? <ErrorNotice message={error.message} nextAction={error.nextAction} /> : null}
    </div>
  );
}
