/**
 * A course label. The swatch is decoration; the code is always present as
 * text, so the pairing survives a colour-blind reader or a greyscale print
 * (WCAG 1.4.1 — colour is never the only means of conveying information).
 */
export function CourseTag({
  code,
  color,
  size = 'md',
}: {
  code: string;
  color: string;
  size?: 'sm' | 'md';
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${size === 'sm' ? 'text-xs' : 'text-sm'}`}>
      <span
        aria-hidden="true"
        className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]"
        style={{ backgroundColor: color }}
      />
      <span className="font-semibold text-[var(--color-ink)]">{code}</span>
    </span>
  );
}
