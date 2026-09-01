/**
 * Every failure state the student can reach renders through this: a written
 * message and a next action, never a stack trace.
 *
 * `detail` and `reference` exist so a failure can be diagnosed from a
 * screenshot. `detail` is a safe, specific phrase written by the server
 * ("the syllabi storage bucket does not exist"); `reference` matches the
 * X-Error-Reference header and the server log line for the same request. Both
 * are rendered small and secondary — the student reads the first two lines,
 * whoever is debugging reads the third.
 */
export function ErrorNotice({
  message,
  nextAction,
  detail,
  reference,
  code,
  onRetry,
  retryLabel = 'Try again',
}: {
  message: string;
  nextAction?: string;
  detail?: string | null;
  reference?: string | null;
  code?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div
      role="alert"
      className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-danger-soft)] p-4"
    >
      <p className="font-semibold text-[var(--color-danger)]">{message}</p>
      {nextAction ? <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{nextAction}</p> : null}

      {detail ? (
        <p className="mt-2 rounded border border-[var(--color-line)] bg-[var(--color-paper)] px-2 py-1.5 font-mono text-xs text-[var(--color-ink-soft)]">
          {detail}
        </p>
      ) : null}

      {onRetry ? (
        <button type="button" onClick={onRetry} className="btn btn-secondary mt-3">
          {retryLabel}
        </button>
      ) : null}

      {code || reference ? (
        <p className="mt-3 font-mono text-[11px] text-[var(--color-ink-faint)]">
          {code ? <span>{code}</span> : null}
          {code && reference ? <span aria-hidden="true"> · </span> : null}
          {reference ? (
            <span>
              ref <strong className="font-semibold">{reference}</strong>
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
