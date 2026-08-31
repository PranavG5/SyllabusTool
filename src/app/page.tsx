import Link from 'next/link';
import { Header } from '@/components/Header';
import { DemoPanel } from '@/components/demo/DemoPanel';

export default function LandingPage() {
  return (
    <>
      <Header
        action={
          <Link href="/login" className="btn btn-primary">
            Sign in
          </Link>
        }
      />

      <main id="main" className="mx-auto max-w-5xl px-4 py-10 sm:py-14">
        <div className="max-w-2xl">
          <h1 className="text-3xl font-bold leading-tight tracking-tight text-[var(--color-ink)] sm:text-4xl">
            Turn your syllabus into a semester calendar.
          </h1>
          <p className="mt-3 text-lg text-[var(--color-ink-soft)]">
            Paste or upload what your professors gave you. Get every deadline in one schedule you can
            export to Google Calendar, Apple Calendar, or Outlook.
          </p>

          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/login" className="btn btn-primary">
              Build my schedule
            </Link>
            <a href="#demo" className="btn btn-secondary">
              Try it without an account
            </a>
          </div>
        </div>

        <section id="demo" className="mt-12 scroll-mt-4">
          <h2 className="text-xl font-semibold text-[var(--color-ink)]">Try it on a real syllabus</h2>
          <p className="mt-1 max-w-2xl text-[var(--color-ink-soft)]">
            This runs the same extractor the full app uses. Nothing is saved and you do not need an
            account.
          </p>
          <div className="mt-4 max-w-3xl">
            <DemoPanel />
          </div>
        </section>

        <section className="mt-14 grid gap-5 sm:grid-cols-3" aria-label="How it works">
          {[
            {
              n: '1',
              h: 'Give it your material',
              p: 'Drop in PDFs, Word files, or screenshots — or just paste the text from Canvas. Several courses at once is fine.',
            },
            {
              n: '2',
              h: 'Check the extraction',
              p: 'Every item is editable and links back to the exact line it came from. Anything we were unsure about is flagged and sorted to the top.',
            },
            {
              n: '3',
              h: 'Put it in your calendar',
              p: 'Download an .ics, subscribe to a live feed that stays in sync when you edit, or write to a dedicated Google calendar.',
            },
          ].map((step) => (
            <div key={step.n} className="card p-5">
              <span
                aria-hidden="true"
                className="grid h-7 w-7 place-items-center rounded-full bg-[var(--color-accent-soft)] text-sm font-bold text-[var(--color-accent)]"
              >
                {step.n}
              </span>
              <h3 className="mt-3 font-semibold text-[var(--color-ink)]">{step.h}</h3>
              <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{step.p}</p>
            </div>
          ))}
        </section>

        <section className="mt-12 max-w-2xl">
          <h2 className="text-xl font-semibold text-[var(--color-ink)]">What happens to your files</h2>
          <ul className="mt-3 space-y-2 text-[var(--color-ink-soft)]">
            <li>
              Your syllabus text is sent to Anthropic&apos;s API to be read. It is not used to train
              models.
            </li>
            <li>Uploaded files are stored privately and deleted automatically after 30 days.</li>
            <li>
              Deleting your account removes your files, your schedule, and any calendar access you
              granted.
            </li>
          </ul>
          <p className="mt-3">
            <Link href="/privacy" className="font-medium text-[var(--color-accent)] hover:underline">
              Read the privacy policy
            </Link>
          </p>
        </section>
      </main>
    </>
  );
}
