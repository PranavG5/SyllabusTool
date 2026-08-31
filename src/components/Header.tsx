import Link from 'next/link';

/** Wordmark plus one contextual action. Deliberately not a nav bar. */
export function Header({ action }: { action?: React.ReactNode }) {
  return (
    <header className="border-b border-[var(--color-line)] bg-[var(--color-paper)]">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 font-semibold text-[var(--color-ink)]">
          <span
            aria-hidden="true"
            className="grid h-7 w-7 place-items-center rounded-md bg-[var(--color-accent)] text-[13px] font-bold text-white"
          >
            S
          </span>
          <span>Syllabus Tool</span>
        </Link>
        {action}
      </div>
    </header>
  );
}
