/**
 * Collapsing the same deadline seen more than once.
 *
 * Two sources of duplicates:
 *  - Overlapping chunks of one document see the same table row twice.
 *  - A student uploads both "syllabus.pdf" and "course-calendar.pdf", and the
 *    midterm is in both.
 *
 * Merging keeps the most informative version of each field rather than picking
 * a winner wholesale — the schedule PDF may carry the date while the syllabus
 * carries the weight.
 */

import { canonicalTitle, normalizeCourseCode, type NormalizedItem } from './normalize';
import type { Confidence } from '@/lib/types';

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

function higherConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;
}

/** Key for items that carry a date: same course, same work, same day. */
function datedKey(item: NormalizedItem): string {
  return `${normalizeCourseCode(item.courseCode).toLowerCase()}|${canonicalTitle(item.title)}|${item.dueDate}`;
}

/** Key ignoring the date, used to fold an undated mention into a dated one. */
function undatedKey(item: NormalizedItem): string {
  return `${normalizeCourseCode(item.courseCode).toLowerCase()}|${canonicalTitle(item.title)}`;
}

function merge(base: NormalizedItem, other: NormalizedItem): NormalizedItem {
  // A stated time beats no time: one document may give the hour where the
  // other only gave the day.
  const preferOtherTime = base.dueTime === null && other.dueTime !== null;
  const dueDate = base.dueDate ?? other.dueDate;

  return {
    ...base,
    // The longer title is usually the un-abbreviated one from the syllabus body.
    title: other.title.length > base.title.length ? other.title : base.title,
    type: base.type === 'other' && other.type !== 'other' ? other.type : base.type,
    courseName: base.courseName ?? other.courseName,
    dueDate,
    dueTime: preferOtherTime ? other.dueTime : base.dueTime,
    weight: base.weight ?? other.weight,
    location: base.location ?? other.location,
    // Keep the fuller snippet: it gives the student more to verify against.
    sourceSnippet:
      other.sourceSnippet.length > base.sourceSnippet.length ? other.sourceSnippet : base.sourceSnippet,
    confidence: dueDate
      ? higherConfidence(base.confidence, other.confidence)
      : base.confidence,
    unresolvedReason: dueDate ? null : (base.unresolvedReason ?? other.unresolvedReason),
    dedupeKey: base.dedupeKey,
  };
}

/**
 * Order matters: dated items are indexed first so an undated mention of the
 * same work folds into the dated one rather than the other way round.
 */
export function dedupeItems(items: NormalizedItem[]): NormalizedItem[] {
  const dated = items.filter((i) => i.dueDate !== null);
  const undated = items.filter((i) => i.dueDate === null);

  const byDatedKey = new Map<string, number>();
  const byUndatedKey = new Map<string, number>();
  const out: NormalizedItem[] = [];

  for (const item of dated) {
    const key = datedKey(item);
    const existing = byDatedKey.get(key);
    if (existing !== undefined) {
      out[existing] = merge(out[existing]!, item);
      continue;
    }
    byDatedKey.set(key, out.length);
    // First dated occurrence of this work owns the undated slot too.
    if (!byUndatedKey.has(undatedKey(item))) byUndatedKey.set(undatedKey(item), out.length);
    out.push(item);
  }

  for (const item of undated) {
    const key = undatedKey(item);
    const existing = byUndatedKey.get(key);
    if (existing !== undefined) {
      out[existing] = merge(out[existing]!, item);
      continue;
    }
    byUndatedKey.set(key, out.length);
    out.push(item);
  }

  return out;
}
