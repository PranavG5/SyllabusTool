import Link from 'next/link';

export default function NotFound() {
  return (
    <main id="main" className="mx-auto max-w-md px-4 py-16 text-center">
      <h1 className="text-2xl font-bold text-[var(--color-ink)]">We could not find that page.</h1>
      <p className="mt-2 text-[var(--color-ink-soft)]">
        The link may be out of date, or the schedule may have been deleted.
      </p>
      <Link href="/" className="btn btn-primary mt-6">
        Go to the home page
      </Link>
    </main>
  );
}
