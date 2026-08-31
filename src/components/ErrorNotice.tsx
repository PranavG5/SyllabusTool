/**
 * Every failure state the student can reach renders through this: a written
 * message and a next action, never a stack trace.
 */
export function ErrorNotice({
  message,
  nextAction,
  onRetry,
  retryLabel = 'Try again',
}: {
  message: string;
  nextAction?: string;
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
      {onRetry ? (
        <button type="button" onClick={onRetry} className="btn btn-secondary mt-3">
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}
