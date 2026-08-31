import type { Confidence } from '@/lib/types';

const COPY: Record<Confidence, { label: string; title: string }> = {
  high: { label: 'Confident', title: 'The syllabus stated this item and its date plainly.' },
  medium: { label: 'Check this', title: 'We had to interpret the layout or resolve a relative date.' },
  low: { label: 'Needs your eyes', title: "We are not sure about this one — please verify it." },
};

/** Text-first, so the flag is readable without relying on the colour. */
export function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  if (confidence === 'high') return null;
  const copy = COPY[confidence];
  return (
    <span
      className="chip"
      style={{
        background: 'var(--color-flag-soft)',
        borderColor: 'var(--color-flag-line)',
        color: 'var(--color-flag)',
      }}
      title={copy.title}
    >
      <span aria-hidden="true">!</span>
      {copy.label}
    </span>
  );
}
