import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { handle, json, clientIp } from '@/lib/http';
import { hashIdentifier } from '@/lib/crypto';
import { consumeRateLimit } from '@/lib/quota';
import { runExtraction } from '@/lib/extract/pipeline';
import { estimateCostUsd } from '@/lib/pricing';
import { createAdminClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { parseMeetingDays } from '@/lib/schedule/relative-dates';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * The anonymous demo: paste text, see a parsed preview, no account.
 *
 * Nothing is written to a user's data — the result is returned and forgotten.
 * The only persistence is a usage_event with a null user_id so demo spend is
 * visible in the same ledger as everything else.
 */

const DEMO_MAX_CHARS = 12_000;
const DEMO_PER_HOUR = 5;
const DEMO_PER_DAY = 20;

const Body = z.object({
  text: z.string().min(20).max(DEMO_MAX_CHARS),
  termStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  termEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  meetingDays: z.string().max(60).nullable().optional(),
  courseHint: z.string().max(120).nullable().optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  return handle('POST /api/demo/extract', async () => {
    const raw = await request.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new AppError('invalid_input', {
        userMessage:
          raw && typeof raw === 'object' && 'text' in raw && typeof raw.text === 'string' && raw.text.length > DEMO_MAX_CHARS
            ? `The demo reads up to ${DEMO_MAX_CHARS.toLocaleString()} characters. Sign in to process a full syllabus.`
            : 'Paste at least a couple of lines of your syllabus to try the demo.',
        nextAction: 'Paste the schedule section and try again.',
      });
    }

    // Anonymous, so the only identity is the caller's IP. Hashed, never stored
    // in the clear, and used solely as a rate-limit bucket.
    const ip = hashIdentifier(clientIp(request));
    const withinHour = await consumeRateLimit(`demo:ip:${ip}:h`, DEMO_PER_HOUR, 3600);
    const withinDay = await consumeRateLimit(`demo:ip:${ip}:d`, DEMO_PER_DAY, 86_400);
    if (!withinHour || !withinDay) {
      throw new AppError('rate_limited', {
        userMessage: "You've used the demo a few times already.",
        nextAction: 'Sign in — accounts get a much higher limit and save your schedule.',
      });
    }

    const started = Date.now();
    const result = await runExtraction({
      sources: [],
      pastedText: parsed.data.text,
      termName: null,
      termStartDate: parsed.data.termStartDate ?? null,
      termEndDate: parsed.data.termEndDate ?? null,
      courseHint: parsed.data.courseHint ?? null,
      meetingDaysByCourse: {},
      defaultMeetingDays: parsed.data.meetingDays ? parseMeetingDays(parsed.data.meetingDays) : [],
    });

    // Demo spend belongs in the same ledger as everything else.
    void createAdminClient()
      .from('usage_events')
      .insert({
        user_id: null,
        kind: 'demo_extraction',
        model: result.model,
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        cache_read_tokens: result.usage.cacheReadTokens,
        cache_write_tokens: result.usage.cacheWriteTokens,
        cost_usd: estimateCostUsd(result.model, result.usage),
        files_count: 0,
        chunks_count: result.chunkCount,
        duration_ms: Date.now() - started,
      })
      .then(({ error }) => {
        if (error) logger.warn('demo.usage_log_failed', { message: error.message });
      });

    return json({
      items: result.items.map((item) => ({
        title: item.title,
        type: item.type,
        course: item.courseCode,
        dueDate: item.dueDate,
        dueTime: item.dueTime,
        timeIsDefault: item.timeIsDefault,
        weight: item.weight,
        location: item.location,
        sourceSnippet: item.sourceSnippet,
        confidence: item.confidence,
        unresolvedReason: item.unresolvedReason,
      })),
    });
  });
}
