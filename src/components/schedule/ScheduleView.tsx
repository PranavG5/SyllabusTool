'use client';

import { useMemo, useState } from 'react';
import { CourseTag } from '@/components/CourseTag';
import { ConfidenceBadge } from '@/components/ConfidenceBadge';
import { groupSchedule, monthGrid } from '@/lib/schedule/group';
import { formatDateLong, formatTime, formatWeekRange, monthName } from '@/lib/format';
import { addDays, diffDays, formatISODate, parseISODate, type CivilDate } from '@/lib/datetime';
import { ITEM_TYPE_LABELS, type Course, type ScheduleItem, type SchedulePayload } from '@/lib/types';

/**
 * The finished schedule. List by default, month grid on demand.
 *
 * Designed at 390px first: the list is a single column of rows that wrap, and
 * the month grid keeps seven columns but drops to dots-plus-count on narrow
 * screens rather than becoming an unreadable smear of truncated text.
 */

type View = 'list' | 'month';

function ItemRow({ item, course }: { item: ScheduleItem; course: Course | undefined }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2.5 sm:px-4">
      <span className="w-[92px] shrink-0 text-sm font-semibold tabular-nums text-[var(--color-ink)]">
        {formatDateLong(item.dueDate)}
      </span>
      <span className="min-w-0 flex-1 basis-40">
        <span className="font-medium text-[var(--color-ink)]">{item.title}</span>
      </span>
      {course ? <CourseTag code={course.code} color={course.color} size="sm" /> : null}
      <span className="chip">{ITEM_TYPE_LABELS[item.type]}</span>
      <span className="hint tabular-nums">
        {item.dueTime ? formatTime(item.dueTime) : 'All day'}
      </span>
      <ConfidenceBadge confidence={item.confidence} />
    </li>
  );
}

function ListView({ payload }: { payload: SchedulePayload }) {
  const [showCompleted, setShowCompleted] = useState(false);
  const grouped = useMemo(
    () => groupSchedule(payload.items, payload.term.timezone),
    [payload.items, payload.term.timezone],
  );
  const courseById = useMemo(
    () => new Map(payload.courses.map((c) => [c.id, c])),
    [payload.courses],
  );

  const section = (title: string, subtitle: string | null, items: ScheduleItem[]) => (
    <section aria-labelledby={`sec-${title.replace(/\s+/g, '-')}`} className="mb-6">
      <h2
        id={`sec-${title.replace(/\s+/g, '-')}`}
        className="mb-2 flex items-baseline gap-2 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]"
      >
        {title}
        {subtitle ? <span className="font-normal normal-case tracking-normal">{subtitle}</span> : null}
      </h2>
      <ul className="divide-y divide-[var(--color-line-soft)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-paper)]">
        {items.map((item) => (
          <ItemRow key={item.id} item={item} course={courseById.get(item.courseId)} />
        ))}
      </ul>
    </section>
  );

  const isEmpty =
    grouped.thisWeek.length === 0 &&
    grouped.upcoming.length === 0 &&
    grouped.undated.length === 0 &&
    grouped.completed.length === 0;

  if (isEmpty) {
    return (
      <div className="card p-6 text-center">
        <p className="font-semibold text-[var(--color-ink)]">Your schedule is empty.</p>
        <p className="hint mt-1">Add a syllabus and every deadline in it lands here.</p>
      </div>
    );
  }

  return (
    <div>
      {grouped.undated.length > 0
        ? section('Needs a date', `${grouped.undated.length} item${grouped.undated.length === 1 ? '' : 's'}`, grouped.undated)
        : null}

      {grouped.thisWeek.length > 0
        ? section('This week', null, grouped.thisWeek)
        : (
          <section className="mb-6">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
              This week
            </h2>
            <p className="card p-4 text-[var(--color-ink-soft)]">Nothing due this week.</p>
          </section>
        )}

      {grouped.upcoming.map((week) =>
        section(formatWeekRange(week.start, week.end), null, week.items),
      )}

      {grouped.completed.length > 0 ? (
        <section className="mb-6">
          <h2 className="mb-2">
            <button
              type="button"
              onClick={() => setShowCompleted((v) => !v)}
              aria-expanded={showCompleted}
              className="btn btn-ghost text-sm font-semibold uppercase tracking-wide"
            >
              <span aria-hidden="true">{showCompleted ? '▾' : '▸'}</span>
              Completed ({grouped.completed.length})
            </button>
          </h2>
          {showCompleted ? (
            <ul className="divide-y divide-[var(--color-line-soft)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-paper)] opacity-75">
              {grouped.completed.map((item) => (
                <ItemRow key={item.id} item={item} course={courseById.get(item.courseId)} />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const WEEKDAY_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function MonthView({ payload }: { payload: SchedulePayload }) {
  const dated = payload.items.filter((i) => i.status === 'active' && i.dueDate);
  const firstDate = dated.length > 0
    ? parseISODate([...dated].sort((a, b) => a.dueDate!.localeCompare(b.dueDate!))[0]!.dueDate!)
    : null;

  const [cursor, setCursor] = useState<{ year: number; month: number }>(() => {
    const start = firstDate ?? { year: new Date().getUTCFullYear(), month: new Date().getUTCMonth() + 1, day: 1 };
    return { year: start.year, month: start.month };
  });

  const courseById = useMemo(() => new Map(payload.courses.map((c) => [c.id, c])), [payload.courses]);
  const byDay = useMemo(() => {
    const map = new Map<string, ScheduleItem[]>();
    for (const item of dated) {
      const list = map.get(item.dueDate!) ?? [];
      list.push(item);
      map.set(item.dueDate!, list);
    }
    return map;
  }, [dated]);

  const grid = monthGrid(cursor.year, cursor.month);

  function shift(months: number) {
    setCursor((c) => {
      const raw = c.month - 1 + months;
      return { year: c.year + Math.floor(raw / 12), month: ((raw % 12) + 12) % 12 + 1 };
    });
  }

  const inMonth = (d: CivilDate) => d.month === cursor.month && d.year === cursor.year;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <button type="button" onClick={() => shift(-1)} className="btn btn-secondary">
          <span aria-hidden="true">←</span>
          <span className="sr-only">Previous month</span>
        </button>
        <h2 className="text-base font-semibold text-[var(--color-ink)]" aria-live="polite">
          {monthName(cursor.month)} {cursor.year}
        </h2>
        <button type="button" onClick={() => shift(1)} className="btn btn-secondary">
          <span aria-hidden="true">→</span>
          <span className="sr-only">Next month</span>
        </button>
      </div>

      <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-paper)]">
        <div className="grid grid-cols-7 border-b border-[var(--color-line)] bg-[var(--color-surface)]">
          {WEEKDAY_INITIALS.map((initial, i) => (
            <div key={WEEKDAY_FULL[i]} className="py-1.5 text-center text-xs font-semibold text-[var(--color-ink-soft)]">
              <span aria-hidden="true">{initial}</span>
              <span className="sr-only">{WEEKDAY_FULL[i]}</span>
            </div>
          ))}
        </div>

        {grid.map((week, wi) => (
          <div key={wi} className="grid grid-cols-7 border-b border-[var(--color-line-soft)] last:border-b-0">
            {week.map((day) => {
              const iso = formatISODate(day);
              const items = byDay.get(iso) ?? [];
              return (
                <div
                  key={iso}
                  className={`min-h-[62px] border-r border-[var(--color-line-soft)] p-1 last:border-r-0 sm:min-h-[92px] ${
                    inMonth(day) ? '' : 'bg-[var(--color-surface)]'
                  }`}
                >
                  <div className={`px-0.5 text-[11px] tabular-nums ${inMonth(day) ? 'text-[var(--color-ink-soft)]' : 'text-[var(--color-ink-faint)]'}`}>
                    {day.day}
                  </div>

                  {/* Phone: a dot per course plus a count, so the cell stays legible. */}
                  <div className="mt-0.5 flex flex-wrap gap-0.5 sm:hidden">
                    {items.slice(0, 4).map((item) => {
                      const course = courseById.get(item.courseId);
                      return (
                        <span
                          key={item.id}
                          title={`${course?.code ?? ''} — ${item.title}`}
                          aria-hidden="true"
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ backgroundColor: course?.color ?? 'var(--color-ink-faint)' }}
                        />
                      );
                    })}
                    {items.length > 0 ? (
                      <span className="sr-only">
                        {items.length} item{items.length === 1 ? '' : 's'}:{' '}
                        {items.map((i) => `${courseById.get(i.courseId)?.code ?? ''} ${i.title}`).join(', ')}
                      </span>
                    ) : null}
                  </div>

                  {/* Wider: the course code as text, colour only as a border. */}
                  <ul className="mt-0.5 hidden space-y-0.5 sm:block">
                    {items.slice(0, 3).map((item) => {
                      const course = courseById.get(item.courseId);
                      return (
                        <li
                          key={item.id}
                          className="truncate rounded-sm border-l-[3px] bg-[var(--color-surface)] px-1 py-0.5 text-[11px] leading-tight text-[var(--color-ink)]"
                          style={{ borderLeftColor: course?.color ?? 'var(--color-ink-faint)' }}
                          title={`${course?.code ?? ''} — ${item.title}`}
                        >
                          <span className="font-semibold">{course?.code}</span> {item.title}
                        </li>
                      );
                    })}
                    {items.length > 3 ? (
                      <li className="px-1 text-[11px] text-[var(--color-ink-faint)]">+{items.length - 3} more</li>
                    ) : null}
                  </ul>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <p className="hint mt-2 sm:hidden">
        Each dot is one deadline, coloured by course. Switch to List for the details.
      </p>
    </div>
  );
}

export function ScheduleView({
  payload,
  defaultView = 'list',
}: {
  payload: SchedulePayload;
  defaultView?: View;
}) {
  const [view, setView] = useState<View>(defaultView);

  return (
    <div>
      <div className="mb-4 flex items-center gap-1" role="group" aria-label="Schedule view">
        {(['list', 'month'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            aria-pressed={view === v}
            className={`btn ${view === v ? 'btn-primary' : 'btn-secondary'}`}
          >
            {v === 'list' ? 'List' : 'Month'}
          </button>
        ))}
      </div>

      {view === 'list' ? <ListView payload={payload} /> : <MonthView payload={payload} />}
    </div>
  );
}

export { addDays, diffDays };
