import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { handle, json, requireUser } from '@/lib/http';
import { createServerClient } from '@/lib/supabase/server';
import { ITEM_TYPES } from '@/lib/types';
import { parseISODate, parseWallTime } from '@/lib/datetime';
import type { ItemRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';

/**
 * Edit and delete from the review table.
 *
 * These run as the signed-in user, so RLS is what stops one student editing
 * another's row — not a WHERE clause in this file. tests/rls proves it.
 */

const Patch = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  type: z.enum(ITEM_TYPES).optional(),
  courseId: z.string().uuid().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  dueTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  weight: z.number().min(0).max(100).nullable().optional(),
  location: z.string().trim().max(200).nullable().optional(),
  status: z.enum(['active', 'dismissed']).optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return handle('PATCH /api/items/[id]', async () => {
    await requireUser();
    const { id } = await params;

    const parsed = Patch.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new AppError('invalid_input', {
        userMessage: "That change didn't look right.",
        nextAction: 'Check the date and time format and try again.',
      });
    }
    const body = parsed.data;

    if (body.dueDate && !parseISODate(body.dueDate)) {
      throw new AppError('invalid_input', {
        userMessage: `${body.dueDate} is not a real date.`,
        nextAction: 'Pick a date from the calendar and try again.',
      });
    }
    if (body.dueTime && !parseWallTime(body.dueTime)) {
      throw new AppError('invalid_input', { userMessage: 'That time was not valid.' });
    }

    const update: Partial<ItemRow> = {};
    if (body.title !== undefined) update.title = body.title;
    if (body.type !== undefined) update.type = body.type;
    if (body.courseId !== undefined) update.course_id = body.courseId;
    if (body.weight !== undefined) update.weight = body.weight;
    if (body.location !== undefined) update.location = body.location;
    if (body.status !== undefined) update.status = body.status;

    if (body.dueDate !== undefined) {
      update.due_date = body.dueDate;
      // Clearing the date clears the time with it: a time without a day is
      // not a deadline.
      if (body.dueDate === null) update.due_time = null;
    }
    if (body.dueTime !== undefined) {
      // Clearing the time turns the item back into an all-day deadline.
      update.due_time = body.dueTime;
    }

    if (Object.keys(update).length === 0) {
      throw new AppError('invalid_input', { userMessage: 'There was nothing to change.' });
    }

    const supabase = await createServerClient();
    const { data, error } = await supabase
      .from('items')
      .update(update)
      .eq('id', id)
      .select('id, revision')
      .maybeSingle();

    if (error) {
      throw new AppError('invalid_input', {
        userMessage: "We couldn't save that change.",
        nextAction: 'Check the fields and try again.',
        cause: error,
      });
    }
    if (!data) throw new AppError('not_found');

    return json({ id: data.id, revision: data.revision });
  });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return handle('DELETE /api/items/[id]', async () => {
    await requireUser();
    const { id } = await params;
    const supabase = await createServerClient();
    const { data } = await supabase.from('items').delete().eq('id', id).select('id').maybeSingle();
    if (!data) throw new AppError('not_found');
    return json({ id: data.id });
  });
}
