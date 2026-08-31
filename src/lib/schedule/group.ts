import {
  addDays, diffDays, formatISODate, parseISODate, startOfWeekMonday, todayIn, type CivilDate,
} from '@/lib/datetime';
import type { ScheduleItem } from '@/lib/types';

/** Grouping for the list view. Pure, so it is straightforward to test. */

export interface WeekGroup {
  key: string;
  start: CivilDate;
  end: CivilDate;
  isCurrentWeek: boolean;
  items: ScheduleItem[];
}

export interface GroupedSchedule {
  /** Due between today and the end of this week — pinned at the top. */
  thisWeek: ScheduleItem[];
  /** Everything after this week, grouped by the week it falls in. */
  upcoming: WeekGroup[];
  /** Already past. Collapsed by default. */
  completed: ScheduleItem[];
  /** No date yet, so it cannot be scheduled. Surfaced, never dropped. */
  undated: ScheduleItem[];
  today: CivilDate;
}

function byDate(a: ScheduleItem, b: ScheduleItem): number {
  const d = (a.dueDate ?? '').localeCompare(b.dueDate ?? '');
  if (d !== 0) return d;
  const t = (a.dueTime ?? '').localeCompare(b.dueTime ?? '');
  return t !== 0 ? t : a.title.localeCompare(b.title);
}

export function groupSchedule(
  items: ScheduleItem[],
  timeZone: string,
  now: Date = new Date(),
): GroupedSchedule {
  const today = todayIn(timeZone, now);
  const weekStart = startOfWeekMonday(today);
  const weekEnd = addDays(weekStart, 6);

  const active = items.filter((i) => i.status === 'active');
  const undated = active.filter((i) => !i.dueDate).sort((a, b) => a.title.localeCompare(b.title));
  const dated = active.filter((i) => i.dueDate).sort(byDate);

  const thisWeek: ScheduleItem[] = [];
  const completed: ScheduleItem[] = [];
  const laterByWeek = new Map<string, ScheduleItem[]>();

  for (const item of dated) {
    const date = parseISODate(item.dueDate!);
    if (!date) {
      undated.push(item);
      continue;
    }
    if (diffDays(date, today) < 0) {
      completed.push(item);
    } else if (diffDays(date, weekEnd) <= 0) {
      thisWeek.push(item);
    } else {
      const key = formatISODate(startOfWeekMonday(date));
      const list = laterByWeek.get(key) ?? [];
      list.push(item);
      laterByWeek.set(key, list);
    }
  }

  const upcoming: WeekGroup[] = [...laterByWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, weekItems]) => {
      const start = parseISODate(key)!;
      return {
        key,
        start,
        end: addDays(start, 6),
        isCurrentWeek: false,
        items: weekItems.sort(byDate),
      };
    });

  return {
    thisWeek,
    upcoming,
    // Most recent first: a student scanning what they just missed wants the
    // last thing, not the first thing of the semester.
    completed: completed.reverse(),
    undated,
    today,
  };
}

/** Six-week grid covering `month`, Monday-first, for the month view. */
export function monthGrid(year: number, month: number): CivilDate[][] {
  const first: CivilDate = { year, month, day: 1 };
  const gridStart = startOfWeekMonday(first);
  const weeks: CivilDate[][] = [];
  for (let w = 0; w < 6; w += 1) {
    const week: CivilDate[] = [];
    for (let d = 0; d < 7; d += 1) week.push(addDays(gridStart, w * 7 + d));
    weeks.push(week);
  }
  return weeks;
}
