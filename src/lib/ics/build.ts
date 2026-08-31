/**
 * ICS generation.
 *
 * Hand-written rather than library-backed because three details decide whether
 * this product works, and all three are things ICS libraries get subtly wrong:
 *
 *  1. **Stable UID.** The UID is derived from the item's database id, so
 *     re-importing an updated feed *updates* the event instead of creating a
 *     second copy. SEQUENCE carries the row's revision counter, which the
 *     database bumps on every user-visible edit, so clients know the newer
 *     version wins.
 *
 *  2. **Dates stay dates; times stay times.** Most syllabus deadlines name a
 *     day and no hour, and those export as all-day events — floating dates
 *     that read "October 15" on every device in every timezone, and cannot
 *     drift onto the 16th for a student who travels. Only an item whose
 *     syllabus actually stated a time becomes a timed event, and that one is
 *     converted to a UTC instant against the term's IANA zone at its own date,
 *     so a 7:30 PM exam in October and one in December get different offsets
 *     and both still read 7:30 PM.
 *
 *  3. **Folding and escaping.** Lines fold at 75 *octets* (not characters) and
 *     never mid-codepoint; text values escape backslash, semicolon, comma and
 *     newline. Get this wrong and Outlook rejects the file.
 */

import {
  parseISODate, parseWallTime, toIcsUtcStamp, toIcsDateStamp, addDays,
  zonedWallTimeToUtc, type CivilDate,
} from '@/lib/datetime';
import { ITEM_TYPE_LABELS, type ScheduleItem, type Course, type Term } from '@/lib/types';

export const ICS_PRODID = '-//Syllabus Tool//Semester Calendar//EN';
/** UID namespace. Must never change: it is baked into every calendar already synced. */
export const UID_DOMAIN = 'syllabustool.app';

/** How long an event block runs after the deadline, when there is room in the day. */
const EVENT_MINUTES = 30;

export interface BuildOptions {
  calendarName: string;
  /** Feed URL, so subscribing clients know where to refresh from. */
  feedUrl?: string;
  /** Where "view this item" links point. */
  appUrl?: string;
  /** Emitted so clients poll a subscribed feed rather than caching forever. */
  refreshInterval?: string;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * RFC 5545 §3.3.11 TEXT escaping. Order matters: backslash first, or the
 * backslashes introduced by the later rules get escaped a second time.
 *
 * Note the doubled backslashes in every replacement — `'\\;'` is the two
 * characters the spec asks for, while `'\;'` is just a semicolon, which is
 * exactly the bug this comment exists to stop someone reintroducing.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Folds to 75 octets per line with a leading space on continuations.
 * Counts UTF-8 bytes and never splits a multi-byte character.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const out: string[] = [];
  let current = '';
  let currentBytes = 0;
  // First line may use 75 octets; continuations lose one to the leading space.
  let budget = 75;

  for (const char of line) {
    const size = encoder.encode(char).length;
    if (currentBytes + size > budget) {
      out.push(current);
      current = char;
      currentBytes = size;
      budget = 74;
    } else {
      current += char;
      currentBytes += size;
    }
  }
  if (current.length > 0) out.push(current);

  return out.map((part, i) => (i === 0 ? part : ` ${part}`)).join('\r\n');
}

function line(name: string, value: string): string {
  return foldLine(`${name}:${value}`);
}

// ---------------------------------------------------------------------------
// Event timing
// ---------------------------------------------------------------------------

export interface EventTiming {
  /** DTSTART/DTEND property lines, already formatted. */
  start: string;
  end: string;
  allDay: boolean;
}

/**
 * A deadline becomes a block that *starts* at the due time — that is the time
 * the student sees at a glance — and ends 30 minutes later, clamped so it can
 * never spill past midnight. Without the clamp every 11:59 PM deadline (the
 * default, so most of them) would end at 00:29 the next day and render across
 * two days in month view.
 */
export function timingFor(
  date: CivilDate,
  time: { hour: number; minute: number } | null,
  timeZone: string,
): EventTiming {
  if (!time) {
    return {
      start: `DTSTART;VALUE=DATE:${toIcsDateStamp(date)}`,
      end: `DTEND;VALUE=DATE:${toIcsDateStamp(addDays(date, 1))}`,
      allDay: true,
    };
  }

  const startInstant = zonedWallTimeToUtc(date, time, timeZone);

  const minutesIntoDay = time.hour * 60 + time.minute;
  const minutesLeftInDay = 24 * 60 - minutesIntoDay;
  const durationMinutes = Math.min(EVENT_MINUTES, Math.max(minutesLeftInDay - 1, 1));
  const endMinutes = minutesIntoDay + durationMinutes;
  const endInstant = zonedWallTimeToUtc(
    date,
    { hour: Math.floor(endMinutes / 60), minute: endMinutes % 60 },
    timeZone,
  );

  return {
    start: `DTSTART:${toIcsUtcStamp(startInstant)}`,
    end: `DTEND:${toIcsUtcStamp(endInstant)}`,
    allDay: false,
  };
}

/**
 * The one identity that must never change for a given item. Derived from the
 * database id, so an edit updates the existing calendar event rather than
 * producing a duplicate.
 */
export function uidFor(itemId: string): string {
  return `${itemId}@${UID_DOMAIN}`;
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

function describe(item: ScheduleItem, course: Course, appUrl?: string): string {
  const parts: string[] = [];
  parts.push(`${ITEM_TYPE_LABELS[item.type]} · ${course.code}${course.name ? ` (${course.name})` : ''}`);
  if (item.dueTime) {
    const t = parseWallTime(item.dueTime);
    if (t) {
      const hour12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
      const suffix = t.hour < 12 ? 'AM' : 'PM';
      parts.push(`Due ${hour12}:${String(t.minute).padStart(2, '0')} ${suffix}`);
    }
  } else {
    parts.push('Due this day. Your syllabus did not give a time.');
  }
  if (item.weight != null) parts.push(`Worth ${item.weight}% of the final grade`);
  if (item.confidence !== 'high') {
    parts.push(`Confidence: ${item.confidence} — worth checking against your syllabus.`);
  }
  parts.push('', 'From your syllabus:', item.sourceSnippet);
  if (appUrl) parts.push('', `Edit: ${appUrl}`);
  return parts.join('\n');
}

function buildEvent(
  item: ScheduleItem,
  course: Course,
  term: Term,
  stamp: string,
  options: BuildOptions,
): string[] | null {
  const date = item.dueDate ? parseISODate(item.dueDate) : null;
  // No date, no calendar event. The item still exists in the app; there is
  // simply nowhere honest to put it.
  if (!date) return null;

  const time = item.dueTime ? parseWallTime(item.dueTime) : null;
  const timing = timingFor(date, time, term.timezone);

  const out: string[] = ['BEGIN:VEVENT'];
  out.push(line('UID', uidFor(item.id)));
  out.push(line('DTSTAMP', stamp));
  out.push(timing.start);
  out.push(timing.end);
  out.push(line('SUMMARY', escapeText(`${course.code} — ${item.title}`)));
  out.push(line('DESCRIPTION', escapeText(describe(item, course, options.appUrl))));
  if (item.location) out.push(line('LOCATION', escapeText(item.location)));
  out.push(line('CATEGORIES', escapeText(ITEM_TYPE_LABELS[item.type])));
  // SEQUENCE is the row's revision counter: clients treat a higher SEQUENCE
  // for the same UID as an update to the event they already hold.
  out.push(line('SEQUENCE', String(item.revision)));
  out.push('STATUS:CONFIRMED');
  out.push('TRANSP:TRANSPARENT');

  // Reminders. An all-day event starts at local midnight, so a trigger
  // measured from DTSTART has to be offset into waking hours: -PT14H is 10:00
  // the previous morning ("due tomorrow") and PT9H is 09:00 on the day itself
  // ("due today"). A raw -P1D would fire at midnight, which nobody reads.
  if (timing.allDay) {
    out.push('BEGIN:VALARM', 'ACTION:DISPLAY', line('DESCRIPTION', escapeText(item.title)), 'TRIGGER:-PT14H', 'END:VALARM');
    out.push('BEGIN:VALARM', 'ACTION:DISPLAY', line('DESCRIPTION', escapeText(item.title)), 'TRIGGER:PT9H', 'END:VALARM');
  } else {
    out.push('BEGIN:VALARM', 'ACTION:DISPLAY', line('DESCRIPTION', escapeText(item.title)), 'TRIGGER:-P1D', 'END:VALARM');
    out.push('BEGIN:VALARM', 'ACTION:DISPLAY', line('DESCRIPTION', escapeText(item.title)), 'TRIGGER:-PT2H', 'END:VALARM');
  }

  out.push('END:VEVENT');
  return out;
}

export interface BuildInput {
  term: Term;
  courses: Course[];
  items: ScheduleItem[];
}

/** Returns a complete ICS document with CRLF line endings. */
export function buildIcs(input: BuildInput, options: BuildOptions, now: Date = new Date()): string {
  const stamp = toIcsUtcStamp(now);
  const coursesById = new Map(input.courses.map((c) => [c.id, c]));

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    line('PRODID', ICS_PRODID),
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    line('X-WR-CALNAME', escapeText(options.calendarName)),
    line('NAME', escapeText(options.calendarName)),
    line('X-WR-TIMEZONE', input.term.timezone),
  ];

  if (options.refreshInterval) {
    lines.push(line('REFRESH-INTERVAL;VALUE=DURATION', options.refreshInterval));
    lines.push(line('X-PUBLISHED-TTL', options.refreshInterval));
  }
  if (options.feedUrl) lines.push(line('SOURCE;VALUE=URI', options.feedUrl));

  // Deterministic order so byte-identical input yields a byte-identical file.
  const sorted = [...input.items].sort((a, b) => {
    const ad = a.dueDate ?? '';
    const bd = b.dueDate ?? '';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  for (const item of sorted) {
    if (item.status !== 'active') continue;
    const course = coursesById.get(item.courseId);
    if (!course) continue;
    const event = buildEvent(item, course, input.term, stamp, options);
    if (event) lines.push(...event);
  }

  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
