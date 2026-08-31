/**
 * Resolving week-relative syllabus dates.
 *
 * Syllabi routinely say "Week 3, Thursday" or "second class of week 5" instead
 * of a date. The extractor is told never to invent a date for these; it emits
 * a structured reference and this module resolves it deterministically against
 * the term start date and the course's meeting days — both collected on the
 * input screen.
 *
 * Week numbering: **Week 1 is the week (Monday–Sunday) containing the term
 * start date.** This is the common US academic convention and is what a
 * student reading "Week 3" off their own syllabus will assume.
 *
 * Anything this module cannot resolve confidently returns `resolved: false`.
 * The caller then stores the item with a null date and `confidence: 'low'`,
 * where the review table flags it for the student. We never guess a date.
 */

import {
  addDays, dayOfWeek, diffDays, startOfWeekMonday,
  WEEKDAY_NAMES, type CivilDate, type WeekdayName,
} from '@/lib/datetime';

export type RelativeKind = 'week_weekday' | 'week_meeting' | 'nth_meeting' | 'unresolvable';

export interface RelativeReference {
  kind: RelativeKind;
  /** 1-based academic week. 0 means the week before classes begin. */
  week: number | null;
  weekday: WeekdayName | null;
  /** 1-based index into the course's meeting days. */
  meetingIndex: number | null;
  /** The literal phrase from the syllabus, kept for the review table. */
  raw: string;
}

export type RelativeResolution =
  | { resolved: true; date: CivilDate; downgrade: boolean; note?: string }
  | { resolved: false; reason: string };

export interface RelativeContext {
  termStart: CivilDate | null;
  termEnd: CivilDate | null;
  /** 0 = Sunday … 6 = Saturday. Empty when the student did not supply them. */
  meetingDays: number[];
}

const MAX_WEEK = 30;
/** A resolved date this far past the term end is a misparse, not a deadline. */
const END_SLACK_DAYS = 21;

function weekdayIndex(name: WeekdayName): number {
  return WEEKDAY_NAMES.indexOf(name);
}

function sortedMeetingDays(days: number[]): number[] {
  return [...new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort(
    (a, b) => a - b,
  );
}

/** Monday that opens academic week `week`, where week 1 contains termStart. */
function mondayOfWeek(termStart: CivilDate, week: number): CivilDate {
  return addDays(startOfWeekMonday(termStart), (week - 1) * 7);
}

/** Calendar date of `weekday` within academic week `week`. */
function dateInWeek(termStart: CivilDate, week: number, weekday: number): CivilDate {
  const monday = mondayOfWeek(termStart, week);
  // Monday is index 0 in an academic week; Sunday closes it.
  const offsetFromMonday = weekday === 0 ? 6 : weekday - 1;
  return addDays(monday, offsetFromMonday);
}

export function resolveRelativeDate(
  ref: RelativeReference,
  ctx: RelativeContext,
): RelativeResolution {
  if (ref.kind === 'unresolvable') {
    return { resolved: false, reason: 'The syllabus described this date in a way we cannot pin down.' };
  }
  if (!ctx.termStart) {
    return { resolved: false, reason: 'We need the term start date to work out which week this is.' };
  }

  const meetingDays = sortedMeetingDays(ctx.meetingDays);
  let date: CivilDate;
  let downgrade = false;
  let note: string | undefined;

  switch (ref.kind) {
    case 'week_weekday': {
      if (ref.week == null || ref.week < 0 || ref.week > MAX_WEEK || !ref.weekday) {
        return { resolved: false, reason: 'The week or weekday in that reference was unusable.' };
      }
      date = dateInWeek(ctx.termStart, ref.week, weekdayIndex(ref.weekday));
      break;
    }

    case 'week_meeting': {
      if (ref.week == null || ref.week < 0 || ref.week > MAX_WEEK) {
        return { resolved: false, reason: 'The week in that reference was unusable.' };
      }
      if (meetingDays.length === 0) {
        return {
          resolved: false,
          reason: 'We need the days this class meets to work out which meeting this is.',
        };
      }
      const index = (ref.meetingIndex ?? 1) - 1;
      const day = meetingDays[index];
      if (day === undefined) {
        return {
          resolved: false,
          reason: `This class meets ${meetingDays.length} time(s) a week, so there is no meeting ${ref.meetingIndex}.`,
        };
      }
      date = dateInWeek(ctx.termStart, ref.week, day);
      break;
    }

    case 'nth_meeting': {
      const target = ref.meetingIndex;
      if (target == null || target < 1 || target > MAX_WEEK * 7) {
        return { resolved: false, reason: 'That meeting number was unusable.' };
      }
      if (meetingDays.length === 0) {
        return {
          resolved: false,
          reason: 'We need the days this class meets to count class meetings.',
        };
      }
      // Walk forward from the term start, counting meeting days.
      let cursor = ctx.termStart;
      let seen = 0;
      const horizon = MAX_WEEK * 7 + 7;
      let found: CivilDate | null = null;
      for (let i = 0; i < horizon; i += 1) {
        if (meetingDays.includes(dayOfWeek(cursor))) {
          seen += 1;
          if (seen === target) {
            found = cursor;
            break;
          }
        }
        cursor = addDays(cursor, 1);
      }
      if (!found) {
        return { resolved: false, reason: 'That meeting falls outside the term.' };
      }
      date = found;
      break;
    }
  }

  // Sanity rails. A resolved date outside the term is far more likely to be a
  // misread week number than a real deadline, so we hand it back unresolved
  // rather than putting a wrong date on a student's calendar.
  if (diffDays(date, ctx.termStart) < 0) {
    if (diffDays(date, ctx.termStart) < -7) {
      return { resolved: false, reason: 'That resolved to a date before the term started.' };
    }
    downgrade = true;
    note = 'Falls in the first week but before your term start date — worth a check.';
  }

  if (ctx.termEnd && diffDays(date, ctx.termEnd) > END_SLACK_DAYS) {
    return { resolved: false, reason: 'That resolved to a date well past the end of the term.' };
  }

  return { resolved: true, date, downgrade, ...(note ? { note } : {}) };
}

/**
 * Best-effort parse of a free-text meeting-days string ("MWF", "Tue/Thu")
 * into weekday numbers. Used only to prefill the input form — the student can
 * always correct it, and an unparseable string yields an empty list.
 */
export function parseMeetingDays(input: string): number[] {
  const text = input.toLowerCase();
  const found = new Set<number>();

  // No /g flag: these are membership tests, and a sticky lastIndex here
  // would make the function depend on call order.
  const longForms: [RegExp, number][] = [
    [/sun(day)?/, 0], [/mon(day)?/, 1], [/tue(s|sday)?/, 2], [/wed(nesday)?/, 3],
    [/thu(r|rs|rsday)?/, 4], [/fri(day)?/, 5], [/sat(urday)?/, 6],
  ];
  for (const [re, day] of longForms) {
    if (re.test(text)) found.add(day);
  }
  if (found.size > 0) return [...found].sort((a, b) => a - b);

  // Compact codes: MWF, TR, MTWRF. R = Thursday, U = Sunday (US convention).
  // Only separators may be stripped — dropping arbitrary letters would turn
  // "async" into Saturday. The whole remainder must be day codes.
  const compact = text.replace(/[\s,/&+.\-]/g, '');
  if (compact.length > 0 && compact.length <= 7 && /^[mtwrfsu]+$/.test(compact)) {
    const map: Record<string, number> = { u: 0, m: 1, t: 2, w: 3, r: 4, f: 5, s: 6 };
    for (const ch of compact) {
      const d = map[ch];
      if (d !== undefined) found.add(d);
    }
  }
  return [...found].sort((a, b) => a - b);
}
