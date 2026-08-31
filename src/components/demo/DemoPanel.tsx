'use client';

import { useId, useState } from 'react';
import { ErrorNotice } from '@/components/ErrorNotice';
import { ConfidenceBadge } from '@/components/ConfidenceBadge';
import { formatDateLong, formatTime } from '@/lib/format';
import type { Confidence, ItemType } from '@/lib/types';

/**
 * The live demo. No account, no upload — paste text, see what comes back.
 *
 * It calls the same extraction pipeline the signed-in path uses, so what a
 * visitor sees here is genuinely what they would get.
 */

interface DemoItem {
  title: string;
  type: ItemType;
  course: string;
  dueDate: string | null;
  dueTime: string | null;
  weight: number | null;
  location: string | null;
  sourceSnippet: string;
  confidence: Confidence;
  unresolvedReason: string | null;
}

const SAMPLE = `CS 2110 — Object-Oriented Programming
Fall 2026 | MWF 10:10–11:00 AM | Gates Hall B01

Week   Date      Topic              Due
1      Aug 28    Arrays             Problem Set 1 (11:59pm)
2      Sep 04    Linked lists       Problem Set 2
4      Sep 16    Heaps              Problem Set 3
6      Sep 30    PRELIM 1, 7:30 PM, Statler Auditorium
7      Oct 07    Graphs             Problem Set 4
10     Oct 28    Hashing            Project proposal due 5:00 PM
Week 13, Thursday — Problem Set 6
15     Dec 02    Wrap-up            Final project due

Office hours: Tuesdays 2–4 PM, Gates 431`;

export function DemoPanel() {
  const [text, setText] = useState(SAMPLE);
  const [items, setItems] = useState<DemoItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; nextAction?: string } | null>(null);
  const textareaId = useId();
  const statusId = useId();

  async function run() {
    setBusy(true);
    setError(null);
    setItems(null);
    try {
      const response = await fetch('/api/demo/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, termStartDate: '2026-08-24', termEndDate: '2026-12-11', meetingDays: 'MWF' }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError({ message: body?.error?.message ?? 'That did not work.', nextAction: body?.error?.nextAction });
        return;
      }
      setItems(body.items as DemoItem[]);
    } catch {
      setError({
        message: 'We could not reach the server.',
        nextAction: 'Check your connection and try again.',
      });
    } finally {
      setBusy(false);
    }
  }

  const flagged = items?.filter((i) => i.confidence !== 'high').length ?? 0;

  return (
    <div className="card p-4 sm:p-5">
      <label htmlFor={textareaId} className="label">
        Paste syllabus text
      </label>
      <textarea
        id={textareaId}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={9}
        spellCheck={false}
        className="field font-mono text-[13px] leading-relaxed"
        aria-describedby={statusId}
      />
      <p id={statusId} className="hint mt-1.5">
        This sample is loaded for you — replace it with your own. Nothing is saved.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" onClick={run} disabled={busy || text.trim().length < 20} className="btn btn-primary">
          {busy ? 'Reading…' : 'Try it'}
        </button>
        {busy ? (
          <span role="status" className="hint">
            Reading your syllabus…
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="mt-4">
          <ErrorNotice message={error.message} nextAction={error.nextAction} onRetry={run} />
        </div>
      ) : null}

      {items ? (
        <div className="mt-5" aria-live="polite">
          <h3 className="text-sm font-semibold text-[var(--color-ink)]">
            {items.length} item{items.length === 1 ? '' : 's'} found
            {flagged > 0 ? ` · ${flagged} to check` : ''}
          </h3>

          {items.length === 0 ? (
            <p className="hint mt-2">
              No deadlines in that text. Try pasting the course schedule section.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-[var(--color-line-soft)] rounded-lg border border-[var(--color-line)]">
              {items.map((item, i) => (
                <li key={`${item.title}-${i}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 p-3">
                  <span className="w-[104px] shrink-0 text-sm font-semibold text-[var(--color-ink)]">
                    {formatDateLong(item.dueDate)}
                  </span>
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="font-medium text-[var(--color-ink)]">{item.title}</span>
                    <span className="text-[var(--color-ink-faint)]"> · {item.course}</span>
                  </span>
                  {item.dueDate ? (
                    <span className="hint">
                      {item.dueTime ? formatTime(item.dueTime) : 'All day'}
                    </span>
                  ) : null}
                  <ConfidenceBadge confidence={item.confidence} />
                  {item.unresolvedReason ? (
                    <p className="w-full text-xs text-[var(--color-flag)]">{item.unresolvedReason}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <p className="hint mt-3">
            In the full app every row is editable, links back to its source text, and exports to your
            calendar.
          </p>
        </div>
      ) : null}
    </div>
  );
}
