/**
 * The contract between the model and the rest of the app.
 *
 * This is a strict structured-output schema handed to the Messages API via
 * `output_config.format`, not a prose instruction — the model cannot return a
 * shape this does not describe. Field descriptions are load-bearing: they are
 * the extraction spec the model actually reads, so edit them as carefully as
 * the prompt itself.
 */

import { z } from 'zod';
import { ITEM_TYPES, CONFIDENCE_LEVELS } from '@/lib/types';
import { WEEKDAY_NAMES } from '@/lib/datetime';

export const RelativeReferenceSchema = z.object({
  kind: z
    .enum(['week_weekday', 'week_meeting', 'nth_meeting', 'unresolvable'])
    .describe(
      'week_weekday: names an academic week and a weekday ("Week 3, Thursday"). ' +
        'week_meeting: names a week and which class meeting within it ("second class of week 5"). ' +
        'nth_meeting: counts class meetings from the start of term ("the 8th class"). ' +
        'unresolvable: anchored to something not in this document, e.g. "the class after spring break".',
    ),
  week: z
    .number()
    .int()
    .nullable()
    .describe('1-based academic week number, or null when the reference does not name a week.'),
  weekday: z
    .enum(WEEKDAY_NAMES)
    .nullable()
    .describe('Lowercase English weekday, or null when the reference does not name one.'),
  meeting_index: z
    .number()
    .int()
    .nullable()
    .describe(
      'Which class meeting, 1-based. For week_meeting it counts within the week; ' +
        'for nth_meeting it counts from the start of term. Null when not applicable.',
    ),
  raw: z
    .string()
    .describe('The exact phrase from the syllabus that expressed this timing, e.g. "Week 3, Thu".'),
});

export const RawItemSchema = z.object({
  title: z
    .string()
    .describe(
      'What is due, as the syllabus names it: "Problem Set 4", "Midterm 2", "Final Project Proposal". ' +
        'Keep the number. Do not add the course code — that goes in course_code.',
    ),
  type: z
    .enum(ITEM_TYPES)
    .describe(
      'assignment: homework, problem sets, labs, essays. quiz: short in-class or online quizzes. ' +
        'exam: midterms, finals, tests. project: multi-week deliverables and their milestones. ' +
        'reading: assigned reading with a date. other: anything else with a deadline.',
    ),
  course_code: z
    .string()
    .describe(
      'The course code as written, e.g. "CS 2110", "HIST 105". If the document has no code, ' +
        'use the course name. When one file covers several courses, label every item with its own course.',
    ),
  course_name: z
    .string()
    .nullable()
    .describe('Full course title if stated, e.g. "Object-Oriented Programming". Null if absent.'),
  due_date: z
    .string()
    .nullable()
    .describe(
      'ISO date (YYYY-MM-DD) ONLY when the document states an actual calendar date, or when it ' +
        'states a month and day you can pair with a year the document gives. ' +
        'NEVER infer, estimate, or invent a date. If the timing is relative ("Week 3"), leave this ' +
        'null and fill relative_reference instead. If there is no timing at all, leave both null.',
    ),
  due_time: z
    .string()
    .nullable()
    .describe(
      'Time of day in 24-hour HH:MM, ONLY if the document states one ("due at 5pm" -> "17:00"). ' +
        'Null when no time is given — do not default it here, the application does that.',
    ),
  relative_reference: RelativeReferenceSchema.nullable().describe(
    'Fill this instead of due_date when the syllabus expresses timing relative to the academic ' +
      'calendar. Null when due_date is set or when there is no timing information at all.',
  ),
  weight: z
    .number()
    .nullable()
    .describe('Percent of the final grade, as a number (15 for "15%"). Null if not stated.'),
  location: z
    .string()
    .nullable()
    .describe('Room or venue if stated, e.g. "Gates B01". Null if not stated.'),
  source_snippet: z
    .string()
    .describe(
      'The exact text from the document this item came from, copied verbatim — one or two lines, ' +
        'or the full table row. Every item MUST have one: it is how the student verifies you. ' +
        'Do not paraphrase and do not write text that is not in the document.',
    ),
  confidence: z
    .enum(CONFIDENCE_LEVELS)
    .describe(
      'high: the document plainly states this item and its date. ' +
        'medium: the item is clear but the date needed interpretation, or the date is relative. ' +
        'low: you are unsure this is a real deliverable, or the date could not be determined.',
    ),
});

export const ExtractionResultSchema = z.object({
  items: z
    .array(RawItemSchema)
    .describe(
      'Every dated deliverable in this document. Empty array if the text contains none — ' +
        'an empty list is a correct answer for a page of course policies.',
    ),
});

export type RawItem = z.infer<typeof RawItemSchema>;
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
export type RelativeReferenceInput = z.infer<typeof RelativeReferenceSchema>;
