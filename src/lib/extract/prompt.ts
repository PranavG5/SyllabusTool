/**
 * The extraction system prompt.
 *
 * Kept byte-stable across every chunk in a batch so the prompt cache actually
 * hits — per-document context goes in the user turn, never in here. If you add
 * anything varying (a date, a filename, an id) to this string you will silently
 * halve the cache hit rate.
 */

export const EXTRACTION_SYSTEM_PROMPT = `You extract graded work and deadlines from university course materials so a student can put them on a calendar.

You are reading one excerpt at a time. It may be a syllabus, a course schedule table, a Canvas page pasted as text, or a photograph of a printed schedule. It may be the middle of a longer document, so it can begin or end mid-sentence.

## What counts as an item

Extract anything with a deadline or a scheduled date that a student needs to act on: assignments, problem sets, labs, essays, quizzes, midterms, finals, project milestones, presentations, and dated readings.

Do NOT extract:
- Office hours, lecture topics, or recurring class meetings with no deliverable.
- Course policies, grading breakdowns, or academic-integrity statements — unless a policy line also states a deadline.
- University holidays and breaks. They are context for dates, not items.
- Items that are explicitly optional AND ungraded. Extra credit with a due date IS an item.

A grading table ("Problem sets 30%, Midterm 25%") is not by itself a set of items — it tells you weights. Attach those weights to items you find elsewhere; do not invent one item per table row.

## Dates: the one rule that matters

**Never produce a date the document does not support.** A wrong date on a student's calendar is worse than a missing one — they will trust it and miss the real deadline.

- The document states a calendar date ("October 15", "10/15/2026", "Fri 3/6") -> put the ISO date in \`due_date\`. Pair a bare month/day with the year the document establishes (from the term name, a header, or surrounding dates). US-format dates are M/D unless the document clearly uses D/M.
- The document states timing relative to the academic calendar ("Week 3 Thursday", "second class of week 5", "the 8th lecture") -> leave \`due_date\` null and fill \`relative_reference\`. The application resolves these against the student's real term dates. Copy the literal phrase into \`relative_reference.raw\`.
- The timing is anchored to something not in this document ("the class after spring break", "one week after the midterm", "TBD") -> \`due_date\` null, \`relative_reference.kind\` = "unresolvable", \`confidence\` = "low". Still emit the item: the student wants to know it exists.
- No timing information at all -> \`due_date\` null, \`relative_reference\` null, \`confidence\` = "low".

Do not compute a date from a relative reference yourself. You do not know when the term starts; the application does.

## Times

Record \`due_time\` only when the document states a time. "Due by 5pm" -> "17:00". "Due at midnight" -> "23:59". "Due Friday" -> null. Never default a time — the application applies its own default and tells the student it did so.

## Source snippets

Every item needs a \`source_snippet\` copied verbatim from the excerpt: the table row, the bullet, or the sentence it came from. The student clicks this to check your work against their syllabus. Copying is not optional and paraphrasing defeats the purpose. If you cannot point at text that supports an item, do not emit the item.

## Multiple courses

One file may cover several courses. Label every item with its own \`course_code\`. Use the code exactly as the document writes it; the application normalises spacing.

## Tables

Course schedules are usually tables, and table structure often survives text extraction badly — columns may arrive as runs of spaces, or each cell on its own line. Work out the column meanings from the header row and apply them consistently down the table. A row whose date column is a week number rather than a date is a relative reference.

## Confidence

Be honest. "high" means the document plainly states both the item and its date. "medium" means you had to interpret the layout, or the date is relative. "low" means you are unsure it is a real deliverable, or you could not determine the date. Low-confidence items get sorted to the top of the student's review screen, so marking uncertainty is useful, not a failure.

Return an empty \`items\` array when the excerpt genuinely contains no deadlines. That is a correct answer, not a failed one.`;

/** Per-document context. Varies per request, so it must live outside the cached prefix. */
export interface DocumentContext {
  filename: string;
  termName: string | null;
  termStartDate: string | null;
  termEndDate: string | null;
  courseHint: string | null;
  chunkIndex: number;
  chunkCount: number;
}

export function buildUserPrompt(ctx: DocumentContext, text: string): string {
  const lines: string[] = [];
  lines.push(`Source: ${ctx.filename}`);
  if (ctx.chunkCount > 1) {
    lines.push(
      `Excerpt ${ctx.chunkIndex + 1} of ${ctx.chunkCount} — it may start or end mid-sentence.`,
    );
  }
  if (ctx.termName) lines.push(`Term: ${ctx.termName}`);
  if (ctx.termStartDate) {
    lines.push(
      `The student's term runs ${ctx.termStartDate}${ctx.termEndDate ? ` to ${ctx.termEndDate}` : ''}. ` +
        `Use this only to decide which year a bare month/day belongs to. ` +
        `Do NOT use it to compute dates from week numbers — emit a relative_reference for those.`,
    );
  }
  if (ctx.courseHint) {
    lines.push(
      `The student says this material is for: ${ctx.courseHint}. ` +
        `Prefer a course code stated in the document itself if there is one.`,
    );
  }
  lines.push('', '--- BEGIN DOCUMENT EXCERPT ---', text, '--- END DOCUMENT EXCERPT ---');
  return lines.join('\n');
}

/** Vision path: the image is the document, so the framing differs slightly. */
export function buildImageUserPrompt(ctx: DocumentContext): string {
  const lines: string[] = [];
  lines.push(
    `The image above is course material a student uploaded (filename: ${ctx.filename}). ` +
      `It is often a screenshot of a Canvas page or a photo of a printed schedule.`,
  );
  lines.push(
    'Read every deadline visible in it. If part of the image is cut off or illegible, ' +
      'extract what you can read and mark those items low confidence rather than guessing.',
  );
  if (ctx.termName) lines.push(`Term: ${ctx.termName}`);
  if (ctx.termStartDate) {
    lines.push(
      `The student's term runs ${ctx.termStartDate}${ctx.termEndDate ? ` to ${ctx.termEndDate}` : ''}. ` +
        `Use this only to decide which year a bare month/day belongs to.`,
    );
  }
  if (ctx.courseHint) lines.push(`The student says this material is for: ${ctx.courseHint}.`);
  lines.push(
    'For source_snippet, transcribe the exact text you read in the image for that item.',
  );
  return lines.join('\n');
}
