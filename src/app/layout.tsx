import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Syllabus Tool — turn your syllabus into a calendar',
    template: '%s · Syllabus Tool',
  },
  description:
    'Paste or upload your syllabus and get a semester schedule you can export to Google Calendar, Apple Calendar, or Outlook.',
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#ffffff',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="skip-link">
          Skip to main content
        </a>
        {children}
        <footer className="mt-16 border-t border-[var(--color-line)] bg-[var(--color-paper)]">
          <div className="mx-auto max-w-5xl px-4 py-8 text-sm text-[var(--color-ink-faint)]">
            <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2">
              <Link href="/" className="hover:text-[var(--color-ink)] hover:underline">Home</Link>
              <Link href="/privacy" className="hover:text-[var(--color-ink)] hover:underline">Privacy</Link>
              <Link href="/terms" className="hover:text-[var(--color-ink)] hover:underline">Terms</Link>
            </nav>
            <p className="mt-4 max-w-2xl">
              Syllabus Tool is an independent product. It is not affiliated with, endorsed by, or
              connected to any university, college, or learning-management system.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
