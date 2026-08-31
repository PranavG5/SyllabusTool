import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { handle, json, requireUser } from '@/lib/http';
import { createServerClient } from '@/lib/supabase/server';
import { ITEM_TYPES } from '@/lib/types';
import { DEFAULT_DUE_TIME, parseISODate } from '@/lib/datetime';

export const runtime = 'nodejs';

/** Adds an item by hand — for the deadline the syllabus never wrote down. */
const Body = z.object({
  courseId: z.string().uuid(),
  title: z.string().trim().min(1).max(300),
  type: z.enum(ITEM_TYPES).default('assignment'),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  dueTime: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
});

export async function POST(request: Request): Promise<NextResponse> {
  return handle('POST /api/items', async () => {
    const user = await requireUser();
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new AppError('invalid_input', { userMessage: 'That item was missing something.' });
    }
    const body = parsed.data;
    if (body.dueDate && !parseISODate(body.dueDate)) {
      throw new AppError('invalid_input', { userMessage: `${body.dueDate} is not a real date.` });
    }

    const supabase = await createServerClient();
    const { data: course } = await supabase
      .from('courses')
      .select('id, term_id')
      .eq('id', body.courseId)
      .maybeSingle();
    if (!course) throw new AppError('not_found');

    const { data, error } = await supabase
      .from('items')
      .insert({
        user_id: user.id,
        term_id: course.term_id,
        course_id: course.id,
        title: body.title,
        type: body.type,
        due_date: body.dueDate,
        due_time: body.dueDate ? (body.dueTime ?? DEFAULT_DUE_TIME) : null,
        time_is_default: Boolean(body.dueDate) && !body.dueTime,
        // Hand-entered items are still traceable — to the student.
        source_snippet: 'Added by you',
        confidence: 'high',
      })
      .select('id')
      .maybeSingle();

    if (error || !data) {
      throw new AppError('invalid_input', { userMessage: "We couldn't add that item.", cause: error });
    }
    return json({ id: data.id }, { status: 201 });
  });
}
