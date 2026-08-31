import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/types';
import type { Course, ScheduleItem, SchedulePayload, Term } from '@/lib/types';

/**
 * Loads a term with its courses and items.
 *
 * Takes the client as an argument so the same query runs either as the
 * signed-in user (RLS enforced — the normal path) or as the service role
 * (the calendar feed, which authenticates by token instead of session).
 */
export async function loadSchedule(
  supabase: SupabaseClient<Database>,
  termId: string | null,
  userId?: string,
): Promise<SchedulePayload | null> {
  let termQuery = supabase
    .from('terms')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1);

  if (termId) termQuery = termQuery.eq('id', termId);
  if (userId) termQuery = termQuery.eq('user_id', userId);

  const { data: terms } = await termQuery;
  const termRow = terms?.[0];
  if (!termRow) return null;

  const [{ data: courseRows }, { data: itemRows }] = await Promise.all([
    supabase.from('courses').select('*').eq('term_id', termRow.id).order('position'),
    supabase.from('items').select('*').eq('term_id', termRow.id),
  ]);

  // Only the uploads these items actually cite, not every file the account has
  // ever produced.
  const referencedUploadIds = [
    ...new Set((itemRows ?? []).map((i) => i.source_upload_id).filter((id): id is string => Boolean(id))),
  ];
  const { data: uploadRows } = referencedUploadIds.length
    ? await supabase.from('uploads').select('id, filename').in('id', referencedUploadIds)
    : { data: [] as { id: string; filename: string }[] };

  const filenameByUpload = new Map((uploadRows ?? []).map((u) => [u.id, u.filename]));

  const term: Term = {
    id: termRow.id,
    name: termRow.name,
    timezone: termRow.timezone,
    startDate: termRow.start_date,
    endDate: termRow.end_date,
  };

  const courses: Course[] = (courseRows ?? []).map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    color: c.color,
    meetingDays: c.meeting_days ?? [],
  }));

  const items: ScheduleItem[] = (itemRows ?? []).map((i) => ({
    id: i.id,
    courseId: i.course_id,
    termId: i.term_id,
    title: i.title,
    type: i.type,
    dueDate: i.due_date,
    // Postgres returns `time` as HH:MM:SS; the UI works in HH:MM.
    dueTime: i.due_time ? i.due_time.slice(0, 5) : null,
    weight: i.weight === null ? null : Number(i.weight),
    location: i.location,
    sourceSnippet: i.source_snippet,
    sourceUploadId: i.source_upload_id,
    sourceFilename: i.source_upload_id ? (filenameByUpload.get(i.source_upload_id) ?? null) : null,
    confidence: i.confidence,
    status: i.status,
    revision: i.revision,
  }));

  return { term, courses, items };
}
