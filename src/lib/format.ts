import { parseISODate, parseWallTime, WEEKDAY_NAMES, dayOfWeek, type CivilDate } from '@/lib/datetime';

/** Shared date/time formatting. Pure, so it renders identically server and client. */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function monthName(month: number): string {
  return MONTHS[month - 1] ?? '';
}

export function formatDateLong(iso: string | null): string {
  const d = iso ? parseISODate(iso) : null;
  if (!d) return 'No date';
  const weekday = WEEKDAY_NAMES[dayOfWeek(d)]!;
  return `${weekday[0]!.toUpperCase()}${weekday.slice(1, 3)} ${monthName(d.month).slice(0, 3)} ${d.day}`;
}

export function formatDateFull(iso: string | null): string {
  const d = iso ? parseISODate(iso) : null;
  if (!d) return 'No date';
  const weekday = WEEKDAY_NAMES[dayOfWeek(d)]!;
  return `${weekday[0]!.toUpperCase()}${weekday.slice(1)}, ${monthName(d.month)} ${d.day}, ${d.year}`;
}

export function formatTime(time: string | null): string {
  const t = time ? parseWallTime(time) : null;
  if (!t) return '';
  const hour12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
  const suffix = t.hour < 12 ? 'AM' : 'PM';
  return `${hour12}:${String(t.minute).padStart(2, '0')} ${suffix}`;
}

/** "Sep 8 – Sep 14" for a week heading. */
export function formatWeekRange(start: CivilDate, end: CivilDate): string {
  const s = `${monthName(start.month).slice(0, 3)} ${start.day}`;
  const e =
    start.month === end.month
      ? `${end.day}`
      : `${monthName(end.month).slice(0, 3)} ${end.day}`;
  return `${s} – ${e}`;
}
