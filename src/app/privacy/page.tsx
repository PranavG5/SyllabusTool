import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage, Section } from '@/components/LegalPage';

export const metadata: Metadata = {
  title: 'Privacy policy',
  description: 'What Syllabus Tool collects, what it sends to a third-party model provider, and how long it keeps anything.',
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy" updated="31 August 2026">
      <p className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-paper)] p-4 text-[var(--color-ink)]">
        The short version: we send your syllabus text to Anthropic&apos;s API so it can be read. We
        store your schedule so you can edit and export it. We delete uploaded files after 30 days,
        and deleting your account deletes everything.
      </p>

      <Section heading="Who we are">
        <p>
          Syllabus Tool is operated by <strong>[Company legal name]</strong>, [registered address].
          Questions about this policy go to <strong>[privacy@yourdomain]</strong>.
        </p>
        <p>
          We are an independent product. We are not affiliated with, endorsed by, sponsored by, or
          connected to any university, college, school, or learning-management system, including
          Canvas, Blackboard, Moodle, or Brightspace. Course names and codes shown in the app come
          from material you give us.
        </p>
      </Section>

      <Section heading="What we collect">
        <ul className="list-disc space-y-1.5 pl-5">
          <li>
            <strong>Your email address</strong>, so you can sign in and so we can send you a sign-in
            link. If you sign in with Google we receive your email address and nothing else.
          </li>
          <li>
            <strong>The files and text you give us</strong> — syllabi, course schedules, screenshots,
            and anything you paste.
          </li>
          <li>
            <strong>The schedule we extract</strong>: item titles, dates, times, weights, locations,
            and the short excerpt of your source text each item came from.
          </li>
          <li>
            <strong>Usage records</strong>: how many extractions you ran, how many tokens each one
            cost, and whether it succeeded. These let us run the service and understand its cost.
          </li>
          <li>
            <strong>Server logs</strong> containing request paths, timings, and error codes. Log
            fields that could carry syllabus content or secrets are redacted before writing.
          </li>
        </ul>
        <p>
          We do not use advertising cookies or third-party analytics trackers. The only cookies we
          set are the ones that keep you signed in and one short-lived cookie that protects the
          Google Calendar connection against cross-site request forgery.
        </p>
      </Section>

      <Section heading="What we send to a third-party model provider">
        <p>
          <strong>This is the part worth reading.</strong> To turn a syllabus into a schedule we send
          the text of your material — and, for screenshots and scanned PDFs, the image itself — to{' '}
          <a className="text-[var(--color-accent)] underline" href="https://www.anthropic.com/" rel="noreferrer noopener" target="_blank">
            Anthropic
          </a>{' '}
          through its API. That text may contain whatever your syllabus contains: your instructor&apos;s
          name, room numbers, course policies, and any personal detail that happens to be in the
          document you upload.
        </p>
        <p>
          We use Anthropic&apos;s commercial API. Under Anthropic&apos;s commercial terms, inputs and
          outputs sent through the API are not used to train their models. Anthropic retains API
          inputs and outputs for a limited period for trust-and-safety purposes. Their handling of
          that data is governed by their own privacy policy and terms, which we do not control.
        </p>
        <p>
          If you would rather not send a particular document to a third party, do not upload it. The
          anonymous demo on our home page also sends the text you paste to the same API.
        </p>
        <p>
          Our other processors are <strong>Supabase</strong> (database, authentication, and file
          storage), <strong>Vercel</strong> (application hosting), and <strong>Sentry</strong> (error
          tracking). If you connect Google Calendar, we send your schedule to{' '}
          <strong>Google</strong>.
        </p>
      </Section>

      <Section heading="How long we keep things">
        <ul className="list-disc space-y-1.5 pl-5">
          <li>
            <strong>Uploaded files</strong>: stored in a private bucket, reachable only through
            short-lived signed links, and deleted automatically 30 days after processing.
          </li>
          <li>
            <strong>Full document text</strong>: held only while your extraction runs, then erased.
            After that the only text we keep is the short excerpt shown against each item, so you can
            check our work.
          </li>
          <li>
            <strong>Your schedule</strong>: kept until you delete the item, the term, or your account.
          </li>
          <li>
            <strong>Usage records</strong>: kept while your account exists, and deleted with it.
          </li>
        </ul>
      </Section>

      <Section heading="Google Calendar">
        <p>
          If you connect Google Calendar we request a single permission:{' '}
          <code className="rounded bg-[var(--color-surface-2)] px-1 py-0.5 text-[13px]">
            calendar.app.created
          </code>
          . This is the narrowest calendar permission Google offers. It lets us create a calendar and
          manage events inside <em>that calendar only</em>. It does not let us read, change, or delete
          your existing calendars, and it does not let us see your other events.
        </p>
        <p>
          We store the resulting refresh token encrypted with AES-256-GCM. Disconnecting, or deleting
          your account, revokes the token with Google and erases our copy. Events already written into
          the calendar we created remain in your Google account until you delete that calendar.
        </p>
        <p>
          Our use of information received from Google APIs adheres to the{' '}
          <a className="text-[var(--color-accent)] underline" href="https://developers.google.com/terms/api-services-user-data-policy" rel="noreferrer noopener" target="_blank">
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
      </Section>

      <Section heading="Your calendar feed address">
        <p>
          Your subscribable calendar address contains a long random token, because calendar apps
          cannot sign in. Anyone who has that address can read your schedule. Treat it like a
          password. You can replace it at any time from your{' '}
          <Link className="text-[var(--color-accent)] underline" href="/account">account page</Link>,
          which immediately breaks the old address.
        </p>
      </Section>

      <Section heading="Your rights">
        <p>
          You can see everything we hold about you in the app itself, correct any of it by editing an
          item, and delete all of it from your account page. Deletion removes your files from storage,
          every database row about you, and any Google permission you granted. It is immediate and it
          is not recoverable.
        </p>
        <p>
          Depending on where you live you may also have rights to access, correct, port, or object to
          our processing of your data, and to complain to a supervisory authority. Write to{' '}
          <strong>[privacy@yourdomain]</strong> and we will respond within 30 days.
        </p>
      </Section>

      <Section heading="Security">
        <p>
          Access to your data is enforced by the database itself through row-level security, not only
          by our application code, and we test that isolation automatically. Files are stored
          privately. Secrets, including our model-provider API key, exist only on the server and never
          reach your browser. No system is perfect; if you find a problem, please write to{' '}
          <strong>[security@yourdomain]</strong>.
        </p>
      </Section>

      <Section heading="Children">
        <p>
          This service is intended for university and college students and is not directed at children
          under 13. We do not knowingly collect information from them.
        </p>
      </Section>

      <Section heading="Changes">
        <p>
          If we change this policy in a way that materially affects you, we will email you before the
          change takes effect. The date at the top always reflects the current version.
        </p>
      </Section>

      <p className="rounded-[var(--radius-card)] border border-[var(--color-flag-line)] bg-[var(--color-flag-soft)] p-4 text-sm text-[var(--color-ink)]">
        <strong>Note for whoever ships this:</strong> the bracketed placeholders above must be filled
        in, and this document reviewed by a lawyer in your jurisdiction, before you take real users.
        It is a substantive starting draft, not legal advice.
      </p>
    </LegalPage>
  );
}
