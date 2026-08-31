'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CourseTag } from '@/components/CourseTag';
import { ConfidenceBadge } from '@/components/ConfidenceBadge';
import { ErrorNotice } from '@/components/ErrorNotice';
import { formatDateFull, formatTime } from '@/lib/format';
import { ITEM_TYPES, ITEM_TYPE_LABELS, type Course, type ItemType, type ScheduleItem, type SchedulePayload } from '@/lib/types';

/**
 * The review table.
 *
 * Two rules shape the whole screen:
 *  - Uncertain rows sort to the top, so the work the student actually needs to
 *    do is the first thing they see rather than something to hunt for.
 *  - Every row can show the exact source text it came from, so verifying does
 *    not mean reopening the PDF.
 *
 * On a phone each row is a card; at wider widths the same markup lays out in
 * columns. It is one DOM either way — no duplicated mobile markup to drift.
 */

const RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

function sortItems(items: ScheduleItem[]): ScheduleItem[] {
  return [...items].sort((a, b) => {
    // Undated first, then low confidence, then by date.
    const aFlag = a.dueDate === null ? -1 : RANK[a.confidence] ?? 3;
    const bFlag = b.dueDate === null ? -1 : RANK[b.confidence] ?? 3;
    if (aFlag !== bFlag) return aFlag - bFlag;
    if (a.dueDate !== b.dueDate) return (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999');
    return a.title.localeCompare(b.title);
  });
}

interface RowProps {
  item: ScheduleItem;
  courses: Course[];
  onChange: (id: string, patch: Partial<ScheduleItem>) => void;
  onDelete: (id: string) => void;
  saving: boolean;
}

function Row({ item, courses, onChange, onDelete, saving }: RowProps) {
  const [showSource, setShowSource] = useState(false);
  const [openingFile, setOpeningFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const course = courses.find((c) => c.id === item.courseId);
  const needsAttention = item.dueDate === null || item.confidence !== 'high';

  /**
   * Opens the original upload through a short-lived signed URL. The window is
   * opened synchronously and navigated once the URL arrives, because opening it
   * after an await trips popup blockers.
   */
  async function openOriginal() {
    if (!item.sourceUploadId) return;
    setOpeningFile(true);
    setFileError(null);
    const tab = window.open('', '_blank', 'noopener,noreferrer');
    try {
      const response = await fetch(`/api/uploads/${item.sourceUploadId}`);
      const body = await response.json();
      if (!response.ok) {
        tab?.close();
        setFileError(body?.error?.message ?? 'We could not open that file.');
        return;
      }
      if (tab) tab.location.href = body.url;
      else window.location.href = body.url;
    } catch {
      tab?.close();
      setFileError('We could not reach the server.');
    } finally {
      setOpeningFile(false);
    }
  }

  return (
    <li
      className={`p-3 sm:px-4 ${needsAttention ? 'bg-[var(--color-flag-soft)]' : 'bg-[var(--color-paper)]'}`}
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        {/* Title + course */}
        <div className="min-w-0 lg:flex-1">
          <label className="sr-only" htmlFor={`title-${item.id}`}>
            Title
          </label>
          <input
            id={`title-${item.id}`}
            type="text"
            value={item.title}
            onChange={(e) => onChange(item.id, { title: e.target.value })}
            disabled={saving}
            className="field font-medium"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {course ? <CourseTag code={course.code} color={course.color} size="sm" /> : null}
            <ConfidenceBadge confidence={item.confidence} />
            {item.dueDate && !item.dueTime ? (
              <span className="chip" title="Your syllabus gave a date but no time, so this goes in your calendar as an all-day item. Set a time if you want one.">
                All day
              </span>
            ) : null}
            {item.weight != null ? <span className="chip">{item.weight}% of grade</span> : null}
          </div>
        </div>

        {/* Date, time, type */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:w-[420px] lg:shrink-0">
          <div className="col-span-2 sm:col-span-2">
            <label className="sr-only" htmlFor={`date-${item.id}`}>Due date</label>
            <input
              id={`date-${item.id}`}
              type="date"
              value={item.dueDate ?? ''}
              onChange={(e) => onChange(item.id, { dueDate: e.target.value || null })}
              disabled={saving}
              className="field"
              aria-invalid={item.dueDate === null}
            />
          </div>
          <div>
            <label className="sr-only" htmlFor={`time-${item.id}`}>
              Due time (optional — leave blank for an all-day item)
            </label>
            <input
              id={`time-${item.id}`}
              type="time"
              value={item.dueTime ?? ''}
              onChange={(e) => onChange(item.id, { dueTime: e.target.value || null })}
              disabled={saving}
              className="field"
              title="Leave blank for an all-day item"
            />
          </div>
          <div>
            <label className="sr-only" htmlFor={`type-${item.id}`}>Type</label>
            <select
              id={`type-${item.id}`}
              value={item.type}
              onChange={(e) => onChange(item.id, { type: e.target.value as ItemType })}
              disabled={saving}
              className="field"
            >
              {ITEM_TYPES.map((t) => (
                <option key={t} value={t}>{ITEM_TYPE_LABELS[t]}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setShowSource((v) => !v)}
            aria-expanded={showSource}
            aria-controls={`source-${item.id}`}
          >
            {showSource ? 'Hide source' : 'Source'}
          </button>
          <button
            type="button"
            className="btn btn-ghost text-[var(--color-danger)]"
            onClick={() => onDelete(item.id)}
            disabled={saving}
          >
            Delete
            <span className="sr-only"> {item.title}</span>
          </button>
        </div>
      </div>

      {item.dueDate === null ? (
        <p className="mt-2 text-sm text-[var(--color-flag)]">
          We could not work out a date for this from your syllabus. Set one, or delete the row.
        </p>
      ) : null}

      {showSource ? (
        <div id={`source-${item.id}`} className="mt-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
            From {item.sourceFilename ?? 'your syllabus'}
          </p>
          <p className="mt-1 whitespace-pre-wrap font-mono text-[13px] leading-relaxed text-[var(--color-ink)]">
            {item.sourceSnippet}
          </p>
          {item.sourceUploadId ? (
            <button
              type="button"
              onClick={openOriginal}
              disabled={openingFile}
              className="btn btn-ghost mt-2 px-0 text-[var(--color-accent)]"
            >
              {openingFile ? 'Opening…' : 'Open the original file'}
              <span className="sr-only"> {item.sourceFilename ?? ''}</span>
            </button>
          ) : null}
          {fileError ? (
            <p role="alert" className="mt-1 text-sm text-[var(--color-flag)]">{fileError}</p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function ReviewTable({ initial }: { initial: SchedulePayload }) {
  const router = useRouter();
  const [items, setItems] = useState(initial.items);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; nextAction?: string } | null>(null);
  const [dirty, setDirty] = useState<Record<string, Partial<ScheduleItem>>>({});

  const byCourse = useMemo(() => {
    const groups = new Map<string, ScheduleItem[]>();
    for (const item of items) {
      const list = groups.get(item.courseId) ?? [];
      list.push(item);
      groups.set(item.courseId, list);
    }
    return initial.courses
      .map((course) => ({ course, items: sortItems(groups.get(course.id) ?? []) }))
      .filter((group) => group.items.length > 0);
  }, [items, initial.courses]);

  const flaggedCount = items.filter((i) => i.dueDate === null || i.confidence !== 'high').length;

  function change(id: string, patch: Partial<ScheduleItem>) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
    setDirty((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function remove(id: string) {
    const previous = items;
    setItems((prev) => prev.filter((i) => i.id !== id));
    const response = await fetch(`/api/items/${id}`, { method: 'DELETE' });
    if (!response.ok) {
      setItems(previous); // put it back rather than silently losing the delete
      setError({ message: 'We could not delete that row.', nextAction: 'Try again in a moment.' });
    }
  }

  async function confirm() {
    setSaving(true);
    setError(null);
    const entries = Object.entries(dirty);

    for (const [id, patch] of entries) {
      const body: Record<string, unknown> = {};
      if (patch.title !== undefined) body.title = patch.title;
      if (patch.type !== undefined) body.type = patch.type;
      if (patch.dueDate !== undefined) body.dueDate = patch.dueDate;
      if (patch.dueTime !== undefined) body.dueTime = patch.dueTime;

      const response = await fetch(`/api/items/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setSaving(false);
        setError({
          message: payload?.error?.message ?? 'One of your edits could not be saved.',
          nextAction: payload?.error?.nextAction ?? 'Check the highlighted row and try again.',
        });
        return;
      }
    }

    setDirty({});
    router.push(`/schedule?termId=${initial.term.id}`);
  }

  return (
    <div className="space-y-6">
      <div
        className="card p-4"
        style={
          flaggedCount > 0
            ? { background: 'var(--color-flag-soft)', borderColor: 'var(--color-flag-line)' }
            : { background: 'var(--color-good-soft)' }
        }
      >
        <p className="font-semibold text-[var(--color-ink)]">
          {items.length} item{items.length === 1 ? '' : 's'} from {byCourse.length} course
          {byCourse.length === 1 ? '' : 's'}
          {flaggedCount > 0 ? ` · ${flaggedCount} need${flaggedCount === 1 ? 's' : ''} a look` : ''}
        </p>
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
          {flaggedCount > 0
            ? 'Rows we were unsure about are highlighted and sorted to the top of each course. Press Source on any row to see the exact text it came from.'
            : 'Everything came through cleanly. Press Source on any row to check it against your syllabus.'}
        </p>
      </div>

      {error ? <ErrorNotice message={error.message} nextAction={error.nextAction} /> : null}

      {byCourse.map(({ course, items: courseItems }) => (
        <section key={course.id} aria-labelledby={`course-${course.id}`}>
          <h2 id={`course-${course.id}`} className="mb-2 flex items-center gap-2 text-base font-semibold">
            <CourseTag code={course.code} color={course.color} />
            {course.name ? (
              <span className="font-normal text-[var(--color-ink-soft)]">{course.name}</span>
            ) : null}
            <span className="hint">
              ({courseItems.length} item{courseItems.length === 1 ? '' : 's'})
            </span>
          </h2>
          <ul className="divide-y divide-[var(--color-line-soft)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-line)]">
            {courseItems.map((item) => (
              <Row key={item.id} item={item} courses={initial.courses} onChange={change} onDelete={remove} saving={saving} />
            ))}
          </ul>
        </section>
      ))}

      {items.length === 0 ? (
        <div className="card p-6 text-center">
          <p className="font-semibold text-[var(--color-ink)]">Nothing to review.</p>
          <p className="hint mt-1">
            We did not find any deadlines in that material. Try uploading the course schedule page.
          </p>
        </div>
      ) : null}

      <div className="sticky bottom-0 -mx-4 border-t border-[var(--color-line)] bg-[var(--color-paper)] px-4 py-3 sm:mx-0 sm:rounded-b-[var(--radius-card)]">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={confirm} disabled={saving || items.length === 0} className="btn btn-primary">
            {saving ? 'Saving…' : 'Confirm'}
          </button>
          <p role="status" aria-live="polite" className="hint">
            {saving
              ? 'Saving your edits…'
              : Object.keys(dirty).length > 0
                ? `${Object.keys(dirty).length} edited row${Object.keys(dirty).length === 1 ? '' : 's'} to save.`
                : 'Your schedule is ready.'}
          </p>
        </div>
      </div>
    </div>
  );
}

export { formatDateFull, formatTime };
