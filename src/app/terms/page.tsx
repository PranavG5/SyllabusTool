import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage, Section } from '@/components/LegalPage';

export const metadata: Metadata = {
  title: 'Terms of service',
  description: 'The terms you agree to when you use Syllabus Tool.',
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of service" updated="31 August 2026">
      <p className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-paper)] p-4 text-[var(--color-ink)]">
        The short version: we read your syllabus and build you a schedule. Check it before you rely on
        it — extraction is automated and can be wrong. Your syllabus stays yours. We are not your
        university.
      </p>

      <Section heading="Who these terms are between">
        <p>
          These terms are an agreement between you and <strong>[Company legal name]</strong>,
          [registered address] (&ldquo;we&rdquo;). By using Syllabus Tool you accept them. If you do
          not accept them, do not use the service.
        </p>
      </Section>

      <Section heading="We are not your university">
        <p>
          Syllabus Tool is an independent product. We are not affiliated with, endorsed by, sponsored
          by, or otherwise connected to any university, college, school, department, instructor, or
          learning-management system, including Canvas, Blackboard, Moodle, and Brightspace. Course
          codes, course names, and instructor names shown in the app come from material you supply and
          do not imply any relationship.
        </p>
      </Section>

      <Section heading="What the service does, and what it cannot promise">
        <p>
          We use an automated language model to read course materials and produce a schedule. This is
          inherently imperfect. It can miss a deadline, read a date wrongly, or produce an item that
          is not real. We designed the app to make checking easy — every item shows the source text it
          came from, and anything we were unsure about is flagged — but{' '}
          <strong>the schedule is a draft you are responsible for verifying against your actual
          syllabus.</strong>
        </p>
        <p>
          <strong>
            We are not responsible for a missed assignment, exam, deadline, grade, or academic
            consequence.
          </strong>{' '}
          Your syllabus and your instructor are the authority on what is due and when. Treat what we
          produce as a convenience, not a system of record.
        </p>
      </Section>

      <Section heading="Your account">
        <p>
          You need an account to save a schedule. Keep your sign-in email secure; anyone with access
          to it can access your account. Tell us at <strong>[support@yourdomain]</strong> if you
          believe your account has been accessed by someone else.
        </p>
        <p>
          You must be old enough to form a binding contract where you live, and at least 13.
        </p>
      </Section>

      <Section heading="Your content">
        <p>
          Your syllabi and the schedules built from them remain yours. You grant us only the licence
          we need to run the service: to store your files, send their text to our model provider for
          processing, produce your schedule, and show it back to you. That licence ends when you
          delete the content or your account.
        </p>
        <p>
          You are responsible for having the right to upload what you upload. Do not upload material
          you are not permitted to share, and do not upload other people&apos;s personal information.
        </p>
      </Section>

      <Section heading="Acceptable use">
        <p>You agree not to:</p>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>upload malware, or content that is unlawful or infringing;</li>
          <li>
            attempt to access another user&apos;s account, data, or calendar feed, or to probe or
            circumvent our security or rate limits;
          </li>
          <li>
            automate the service beyond normal personal use, resell access, or use it to bulk-process
            documents unrelated to your own coursework;
          </li>
          <li>use the service to attack, overload, or degrade our systems or our providers&apos;.</li>
        </ul>
        <p>
          We may suspend or close an account that does these things, and we may impose or adjust usage
          limits to keep the service available for everyone.
        </p>
      </Section>

      <Section heading="Usage limits">
        <p>
          The free plan includes a monthly allowance of schedule builds, plus per-hour and per-batch
          caps. Your current allowance is shown on your{' '}
          <Link className="text-[var(--color-accent)] underline" href="/account">account page</Link>.
          Editing and exporting a schedule you already have does not count against it. We may change
          the allowance with notice.
        </p>
      </Section>

      <Section heading="Third-party services">
        <p>
          The service depends on Anthropic, Supabase, Vercel, and — if you connect it — Google
          Calendar. Their availability and their terms are outside our control. Our{' '}
          <Link className="text-[var(--color-accent)] underline" href="/privacy">privacy policy</Link>{' '}
          explains what we send to each of them.
        </p>
      </Section>

      <Section heading="Availability">
        <p>
          The service is provided as-is and as-available. We do not promise it will be uninterrupted
          or error-free, and we may change or discontinue features. If we discontinue the service
          entirely, we will give you reasonable notice and a way to export your schedule first.
        </p>
      </Section>

      <Section heading="Disclaimers and liability">
        <p>
          To the fullest extent the law allows, we disclaim all implied warranties, including
          merchantability, fitness for a particular purpose, and non-infringement.
        </p>
        <p>
          To the fullest extent the law allows, we are not liable for indirect, incidental, special,
          consequential, or punitive damages, or for lost profits, data, or academic opportunity. Our
          total liability for any claim relating to the service is limited to the greater of the
          amount you paid us in the twelve months before the claim, or <strong>US$50</strong>.
        </p>
        <p>
          Some jurisdictions do not allow these limits. Where that is so, they apply only to the
          extent permitted, and nothing here limits liability for fraud, death, or personal injury
          caused by negligence.
        </p>
      </Section>

      <Section heading="Ending it">
        <p>
          You can delete your account at any time from your account page, which erases your files and
          data. We may suspend or close an account that breaches these terms, and will tell you why
          where we reasonably can.
        </p>
      </Section>

      <Section heading="Changes to these terms">
        <p>
          We may update these terms. If a change materially affects your rights, we will email you
          before it takes effect. Continuing to use the service after that means you accept the new
          terms.
        </p>
      </Section>

      <Section heading="Governing law">
        <p>
          These terms are governed by the laws of <strong>[jurisdiction]</strong>, and disputes will
          be heard in the courts of <strong>[venue]</strong>, without prejudice to any mandatory
          consumer rights you have where you live.
        </p>
      </Section>

      <Section heading="Contact">
        <p>
          <strong>[support@yourdomain]</strong>
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
