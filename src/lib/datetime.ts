/**
 * Calendar and timezone arithmetic.
 *
 * Two rules hold everywhere in this file:
 *
 *  1. A "civil date" (2026-10-15) and a "wall time" (23:59) are *not* instants.
 *     They only become an instant once paired with an IANA timezone. Deadlines
 *     are stored as civil date + wall time + the term's zone, and converted at
 *     export time — which is why an 11:59 PM deadline stays 11:59 PM on both
 *     sides of a DST transition instead of sliding to 10:59 PM or 12:59 AM.
 *
 *  2. Civil-date arithmetic runs on UTC-midnight Date objects, so the server's
 *     own TZ setting can never change a result.
 */

/** Deadlines with no stated time land here, and are flagged as inferred. */
export const DEFAULT_DUE_TIME = '23:59';

export const WEEKDAY_NAMES = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
] as const;

export type WeekdayName = (typeof WEEKDAY_NAMES)[number];

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WALL_TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

export interface CivilDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

export function parseISODate(value: string): CivilDate | null {
  const m = ISO_DATE.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Round-trip through UTC to reject 2026-02-30 and friends.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

export function formatISODate(d: CivilDate): string {
  return `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

/** UTC-midnight Date for a civil date. Only ever used as an arithmetic carrier. */
export function toUtcMidnight(d: CivilDate): Date {
  return new Date(Date.UTC(d.year, d.month - 1, d.day));
}

export function fromUtcMidnight(date: Date): CivilDate {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function addDays(d: CivilDate, days: number): CivilDate {
  const t = toUtcMidnight(d);
  t.setUTCDate(t.getUTCDate() + days);
  return fromUtcMidnight(t);
}

export function diffDays(a: CivilDate, b: CivilDate): number {
  return Math.round((toUtcMidnight(a).getTime() - toUtcMidnight(b).getTime()) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(d: CivilDate): number {
  return toUtcMidnight(d).getUTCDay();
}

export function parseWallTime(value: string): { hour: number; minute: number } | null {
  const m = WALL_TIME.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function formatWallTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Timezone conversion
// ---------------------------------------------------------------------------

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Offset of `timeZone` from UTC, in milliseconds, at the given instant.
 * Positive east of Greenwich (Berlin in summer = +7_200_000).
 */
export function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  const get = (t: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === t);
    return p ? Number(p.value) : 0;
  };
  const asIfUtc = Date.UTC(
    get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'),
  );
  // formatToParts drops sub-second precision, so compare against a floored instant.
  return asIfUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * Converts a wall-clock reading in `timeZone` to the UTC instant it names.
 *
 * Two passes: guess the offset from the naive instant, correct, then re-check
 * in case the correction crossed a DST transition. Around a "spring forward"
 * gap the named time does not exist and this resolves to the instant just
 * after the jump; around a "fall back" overlap it resolves to the first
 * (pre-transition) occurrence. Both are deterministic, which is what matters
 * for a stable ICS UID.
 */
export function zonedWallTimeToUtc(
  date: CivilDate,
  time: { hour: number; minute: number },
  timeZone: string,
): Date {
  const naive = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute, 0, 0);
  const firstOffset = zoneOffsetMs(naive, timeZone);
  let instant = naive - firstOffset;
  const secondOffset = zoneOffsetMs(instant, timeZone);
  if (secondOffset !== firstOffset) instant = naive - secondOffset;
  return new Date(instant);
}

/** `20261015T235900Z` — the ICS UTC form. */
export function toIcsUtcStamp(instant: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${p(instant.getUTCFullYear(), 4)}${p(instant.getUTCMonth() + 1)}${p(instant.getUTCDate())}` +
    `T${p(instant.getUTCHours())}${p(instant.getUTCMinutes())}${p(instant.getUTCSeconds())}Z`
  );
}

/** `20261015` — the ICS floating date form, used for all-day events. */
export function toIcsDateStamp(d: CivilDate): string {
  return formatISODate(d).replace(/-/g, '');
}

/** The civil date it is *right now* in `timeZone`. */
export function todayIn(timeZone: string, now: Date = new Date()): CivilDate {
  const parts = formatterFor(timeZone).formatToParts(now);
  const get = (t: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((x) => x.type === t)?.value ?? '0');
  return { year: get('year'), month: get('month'), day: get('day') };
}

/**
 * Monday that starts the week containing `d`.
 * Academic "Week N" numbering is anchored on this — see resolveRelativeDate.
 */
export function startOfWeekMonday(d: CivilDate): CivilDate {
  const dow = dayOfWeek(d); // 0 = Sunday
  const backToMonday = dow === 0 ? 6 : dow - 1;
  return addDays(d, -backToMonday);
}
