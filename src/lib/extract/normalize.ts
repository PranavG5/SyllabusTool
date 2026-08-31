/**
 * Turning raw model output into storable items.
 *
 * Everything here is deterministic: date resolution, the 11:59 PM default,
 * course-code normalisation, and the guards that drop items the model should
 * not have produced (an item with no source snippet, a date outside the term).
 */

import {
  DEFAULT_DUE_TIME, parseISODate, formatISODate, parseWallTime, formatWallTime,
  type CivilDate,
} from '@/lib/datetime';
import { resolveRelativeDate, type RelativeContext, type RelativeReference } from '@/lib/schedule/relative-dates';
import type { Confidence, ItemType } from '@/lib/types';
import type { RawItem } from './schema';

export interface NormalizedItem {
  title: string;
  type: ItemType;
  courseCode: string;
  courseName: string | null;
  dueDate: string | null;
  dueTime: string | null;
  timeIsDefault: boolean;
  weight: number | null;
  location: string | null;
  sourceSnippet: string;
  confidence: Confidence;
  dedupeKey: string;
  /** Why a date could not be resolved — surfaced in the review table. */
  unresolvedReason: string | null;
}

export interface NormalizeContext {
  termStart: CivilDate | null;
  termEnd: CivilDate | null;
  /** Meeting days keyed by normalised course code, for week_meeting references. */
  meetingDaysByCourse: Record<string, number[]>;
  defaultMeetingDays: number[];
}

/**
 * "cs2110" / "CS  2110" / "Cs-2110" all become "CS 2110" so the same course
 * from two different files groups together.
 */
export function normalizeCourseCode(raw: string): string {
  const cleaned = raw.trim().replace(/\s+/g, ' ').replace(/[–—]/g, '-');
  if (cleaned.length === 0) return 'Unknown course';
  // Insert a space between a leading letter run and a trailing digit run.
  const compact = cleaned.replace(/^([A-Za-z]{2,8})[\s\-_]*([0-9]{2,4}[A-Za-z]?)$/, '$1 $2');
  const looksLikeCode = /^[A-Za-z]{2,8} ?[0-9]{2,4}[A-Za-z]?$/.test(compact);
  return looksLikeCode ? compact.toUpperCase() : cleaned;
}

const TITLE_ABBREVIATIONS: [RegExp, string][] = [
  [/\bp\.?\s?sets?\b/g, 'problem set'],
  [/\bpsets?\b/g, 'problem set'],
  [/\bps\s*(?=\d)/g, 'problem set '],
  [/\bhw\s*(?=\d)/g, 'homework '],
  [/\bhws?\b/g, 'homework'],
  [/\bassign(ment)?\.?\s*(?=\d)/g, 'assignment '],
  [/\bmt\s*(?=\d)/g, 'midterm '],
  [/\bexam\s*(?=\d)/g, 'exam '],
  [/\blab\s*(?=\d)/g, 'lab '],
  [/\bproj(ect)?\.?\s*(?=\d)/g, 'project '],
  [/\bquiz\s*(?=\d)/g, 'quiz '],
  [/\bfinal exam\b/g, 'final'],
];

const ROMAN: Record<string, string> = { i: '1', ii: '2', iii: '3', iv: '4', v: '5' };

/**
 * Canonical title used only for duplicate detection. "Problem Set 4",
 * "PS4" and "Problem set #4" all collapse to "problem set 4".
 */
export function canonicalTitle(title: string): string {
  let t = title.toLowerCase().trim();
  t = t.replace(/[#().,:;'"‘’“”]/g, ' ');
  t = t.replace(/[-_/]+/g, ' ');
  t = t.replace(/\s+/g, ' ');
  for (const [re, replacement] of TITLE_ABBREVIATIONS) t = t.replace(re, replacement);
  t = t.replace(/\b(i{1,3}|iv|v)\b/g, (m) => ROMAN[m] ?? m);
  t = t.replace(/\b(due|deadline|the|a|an)\b/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

export function buildDedupeKey(courseCode: string, title: string, dueDate: string | null): string {
  return `${normalizeCourseCode(courseCode).toLowerCase()}|${canonicalTitle(title)}|${dueDate ?? ''}`;
}

function clampWeight(weight: number | null): number | null {
  if (weight == null || !Number.isFinite(weight)) return null;
  if (weight < 0 || weight > 100) return null;
  return Math.round(weight * 100) / 100;
}

function toRelativeReference(raw: RawItem['relative_reference']): RelativeReference | null {
  if (!raw) return null;
  return {
    kind: raw.kind,
    week: raw.week,
    weekday: raw.weekday,
    meetingIndex: raw.meeting_index,
    raw: raw.raw,
  };
}

const MAX_SNIPPET_CHARS = 600;
const MAX_TITLE_CHARS = 300;

/**
 * Normalises one raw item, or returns null when it must be dropped.
 * The only reason to drop is a missing source snippet or title: an item we
 * cannot trace back to the document has no place on a student's calendar.
 */
export function normalizeItem(raw: RawItem, ctx: NormalizeContext): NormalizedItem | null {
  const title = raw.title?.trim().slice(0, MAX_TITLE_CHARS) ?? '';
  const snippet = raw.source_snippet?.trim().slice(0, MAX_SNIPPET_CHARS) ?? '';
  if (title.length === 0 || snippet.length === 0) return null;

  const courseCode = normalizeCourseCode(raw.course_code ?? '');
  let confidence: Confidence = raw.confidence ?? 'medium';
  let dueDate: string | null = null;
  let unresolvedReason: string | null = null;

  // 1. An explicit date in the document always wins.
  if (raw.due_date) {
    const parsed = parseISODate(raw.due_date);
    if (parsed) {
      dueDate = formatISODate(parsed);
    } else {
      unresolvedReason = 'The date in the source text was not something we could read.';
      confidence = 'low';
    }
  }

  // 2. Otherwise resolve a relative reference deterministically.
  if (!dueDate) {
    const ref = toRelativeReference(raw.relative_reference);
    if (ref) {
      const meetingDays =
        ctx.meetingDaysByCourse[courseCode.toLowerCase()] ?? ctx.defaultMeetingDays;
      const relCtx: RelativeContext = {
        termStart: ctx.termStart,
        termEnd: ctx.termEnd,
        meetingDays,
      };
      const resolution = resolveRelativeDate(ref, relCtx);
      if (resolution.resolved) {
        dueDate = formatISODate(resolution.date);
        // A resolved relative date is inherently an inference, never "high".
        confidence = resolution.downgrade ? 'low' : confidence === 'high' ? 'medium' : confidence;
      } else {
        unresolvedReason = resolution.reason;
        confidence = 'low';
      }
    } else if (!raw.due_date) {
      unresolvedReason = 'The source text did not give a date for this.';
      confidence = 'low';
    }
  }

  // 3. Time: use what the document said, otherwise default and say so.
  let dueTime: string | null = null;
  let timeIsDefault = false;
  if (raw.due_time) {
    const parsed = parseWallTime(raw.due_time);
    if (parsed) dueTime = formatWallTime(parsed.hour, parsed.minute);
  }
  if (!dueTime && dueDate) {
    dueTime = DEFAULT_DUE_TIME;
    timeIsDefault = true;
  }

  return {
    title,
    type: raw.type ?? 'other',
    courseCode,
    courseName: raw.course_name?.trim() || null,
    dueDate,
    dueTime,
    timeIsDefault,
    weight: clampWeight(raw.weight),
    location: raw.location?.trim() || null,
    sourceSnippet: snippet,
    confidence,
    dedupeKey: buildDedupeKey(courseCode, title, dueDate),
    unresolvedReason,
  };
}

export function normalizeItems(raws: RawItem[], ctx: NormalizeContext): NormalizedItem[] {
  const out: NormalizedItem[] = [];
  for (const raw of raws) {
    const item = normalizeItem(raw, ctx);
    if (item) out.push(item);
  }
  return out;
}
