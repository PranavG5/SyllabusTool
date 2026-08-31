/** Domain types shared by the server, the API routes, and the React UI. */

export const ITEM_TYPES = ['assignment', 'quiz', 'exam', 'project', 'reading', 'other'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export type ItemStatus = 'active' | 'dismissed';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed';

export interface Term {
  id: string;
  name: string;
  /** IANA zone. Every deadline is interpreted against this. */
  timezone: string;
  startDate: string | null;
  endDate: string | null;
}

export interface Course {
  id: string;
  code: string;
  name: string | null;
  color: string;
  /** 0 = Sunday … 6 = Saturday. */
  meetingDays: number[];
}

export interface ScheduleItem {
  id: string;
  courseId: string;
  termId: string;
  title: string;
  type: ItemType;
  /** ISO date, or null when the extractor could not resolve one. */
  dueDate: string | null;
  /**
   * HH:MM wall time in the term's zone, or null for a day-level deadline.
   * Null is the common case: most syllabi give a date and no hour, and we do
   * not invent one. Null exports as an all-day event.
   */
  dueTime: string | null;
  weight: number | null;
  location: string | null;
  sourceSnippet: string;
  sourceUploadId: string | null;
  sourceFilename: string | null;
  confidence: Confidence;
  status: ItemStatus;
  /** Exported as ICS SEQUENCE so re-imports update instead of duplicating. */
  revision: number;
}

/** Everything the review and schedule screens need, in one payload. */
export interface SchedulePayload {
  term: Term;
  courses: Course[];
  items: ScheduleItem[];
}

export interface JobFileError {
  filename: string;
  reason: string;
}

export interface JobState {
  id: string;
  status: JobStatus;
  totalFiles: number;
  processedFiles: number;
  itemCount: number;
  fileErrors: JobFileError[];
  errorMessage: string | null;
  termId: string | null;
}

/**
 * Colour is decoration; the course code always appears as text beside it, so
 * colour is never the only thing distinguishing two courses (WCAG 1.4.1).
 * Chosen for >= 3:1 contrast against both the light and dark page grounds.
 */
export const COURSE_COLORS = [
  '#2563eb', // blue
  '#c2410c', // orange
  '#15803d', // green
  '#7c3aed', // violet
  '#be123c', // rose
  '#0f766e', // teal
  '#a16207', // amber
  '#4338ca', // indigo
] as const;

export function courseColorFor(index: number): string {
  return COURSE_COLORS[index % COURSE_COLORS.length]!;
}

export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  assignment: 'Assignment',
  quiz: 'Quiz',
  exam: 'Exam',
  project: 'Project',
  reading: 'Reading',
  other: 'Other',
};
