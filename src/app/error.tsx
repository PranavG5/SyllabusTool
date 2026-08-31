'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';

/**
 * The last line of defence for the "never show a raw stack trace" rule.
 * The real error goes to Sentry; the student gets a sentence and a next step.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <main id="main" className="mx-auto max-w-md px-4 py-16 text-center">
      <h1 className="text-2xl font-bold text-[var(--color-ink)]">Something went wrong.</h1>
      <p className="mt-2 text-[var(--color-ink-soft)]">
        That is our fault, not yours. Nothing you have saved was lost.
      </p>
      <div className="mt-6 flex justify-center gap-3">
        <button type="button" onClick={reset} className="btn btn-primary">
          Try again
        </button>
        <a href="/schedule" className="btn btn-secondary">
          Go to my schedule
        </a>
      </div>
      {error.digest ? (
        <p className="mt-6 text-xs text-[var(--color-ink-faint)]">
          If you contact support, quote reference <code>{error.digest}</code>.
        </p>
      ) : null}
    </main>
  );
}
