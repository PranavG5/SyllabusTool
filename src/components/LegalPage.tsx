import Link from 'next/link';
import { Header } from '@/components/Header';

/** Shared shell for the policy pages: readable measure, real heading structure. */
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <Header action={<Link href="/" className="btn btn-secondary">Home</Link>} />
      <main id="main" className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="text-3xl font-bold tracking-tight text-[var(--color-ink)]">{title}</h1>
        <p className="mt-1 text-sm text-[var(--color-ink-faint)]">Last updated {updated}</p>
        <div className="legal mt-8 space-y-6 text-[var(--color-ink-soft)]">{children}</div>
      </main>
    </>
  );
}

export function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-[var(--color-ink)]">{heading}</h2>
      <div className="mt-2 space-y-3">{children}</div>
    </section>
  );
}
