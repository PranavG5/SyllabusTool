import 'server-only';

/**
 * The single quota gate.
 *
 * Every extraction path calls `consumeExtractionQuota`. The decision itself is
 * made by `public.consume_extraction_quota` in Postgres, under a per-user
 * advisory lock, so two concurrent serverless invocations cannot both slip
 * through on the last remaining credit.
 *
 * Adding a paid tier is a row in `plan_limits` plus setting `users.plan`.
 * Nothing in this file or its callers changes.
 */

import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { createAdminClient } from '@/lib/supabase/server';
import {
  ABSOLUTE_MAX_FILES, ABSOLUTE_MAX_FILE_BYTES, ABSOLUTE_MAX_PDF_PAGES,
} from '@/lib/parse/limits';

export interface PlanLimits {
  plan: string;
  monthlyExtractions: number;
  maxFilesPerBatch: number;
  maxFileBytes: number;
  maxPdfPages: number;
  extractionsPerHour: number;
  maxInputChars: number;
}

export interface QuotaDecision {
  allowed: boolean;
  reason?: string;
  plan: string;
  used: number;
  limit: number;
  limits: PlanLimits;
}

export const FALLBACK_LIMITS: PlanLimits = {
  plan: 'free',
  monthlyExtractions: 20,
  maxFilesPerBatch: 10,
  maxFileBytes: 20 * 1024 * 1024,
  maxPdfPages: 60,
  extractionsPerHour: 10,
  maxInputChars: 400_000,
};

/** Clamps DB-sourced limits to the absolute ceilings this code can honour. */
function clampLimits(raw: Record<string, unknown> | null | undefined): PlanLimits {
  const num = (key: string, fallback: number): number => {
    const v = raw?.[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  return {
    plan: typeof raw?.plan === 'string' ? raw.plan : FALLBACK_LIMITS.plan,
    monthlyExtractions: num('monthlyExtractions', FALLBACK_LIMITS.monthlyExtractions),
    maxFilesPerBatch: Math.min(num('maxFilesPerBatch', FALLBACK_LIMITS.maxFilesPerBatch), ABSOLUTE_MAX_FILES),
    maxFileBytes: Math.min(num('maxFileBytes', FALLBACK_LIMITS.maxFileBytes), ABSOLUTE_MAX_FILE_BYTES),
    maxPdfPages: Math.min(num('maxPdfPages', FALLBACK_LIMITS.maxPdfPages), ABSOLUTE_MAX_PDF_PAGES),
    extractionsPerHour: num('extractionsPerHour', FALLBACK_LIMITS.extractionsPerHour),
    maxInputChars: num('maxInputChars', FALLBACK_LIMITS.maxInputChars),
  };
}

function decisionFrom(payload: Record<string, unknown>): QuotaDecision {
  const limits = clampLimits(payload.limits as Record<string, unknown> | undefined);
  return {
    allowed: payload.allowed === true,
    reason: typeof payload.reason === 'string' ? payload.reason : undefined,
    plan: typeof payload.plan === 'string' ? payload.plan : limits.plan,
    used: typeof payload.used === 'number' ? payload.used : 0,
    limit: typeof payload.limit === 'number' ? payload.limit : limits.monthlyExtractions,
    limits,
  };
}

/**
 * Reserves one extraction for `userId`. Throws AppError when refused, so a
 * caller that forgets to check the result still fails closed.
 */
export async function consumeExtractionQuota(userId: string, files: number): Promise<QuotaDecision> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc('consume_extraction_quota', {
    p_user_id: userId,
    p_files: files,
  });

  if (error) {
    logger.error('quota.rpc_failed', { userId, message: error.message });
    // Fail closed: an unavailable quota check is not permission to extract.
    throw new AppError('internal', { context: { reason: 'quota check failed' } });
  }

  const decision = decisionFrom((data ?? {}) as Record<string, unknown>);
  if (decision.allowed) return decision;

  logger.info('quota.denied', { userId, reason: decision.reason, used: decision.used });

  switch (decision.reason) {
    case 'monthly_quota_exceeded':
      throw new AppError('quota_exceeded', {
        userMessage: `You've used all ${decision.limit} schedule builds on the ${decision.plan} plan this month.`,
      });
    case 'rate_limited':
      throw new AppError('rate_limited');
    case 'too_many_files':
      throw new AppError('too_many_files', {
        userMessage: `You can upload up to ${decision.limits.maxFilesPerBatch} files at a time.`,
      });
    case 'no_account':
      throw new AppError('unauthorized');
    default:
      throw new AppError('internal', { context: { reason: decision.reason } });
  }
}

/** Read-only view of the same numbers, for showing "3 of 20 used". */
export async function getQuotaStatus(userId: string): Promise<{
  plan: string;
  used: number;
  limit: number;
  remaining: number;
  limits: PlanLimits;
}> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc('get_quota_status', { p_user_id: userId });
  if (error || !data) {
    return { plan: 'free', used: 0, limit: FALLBACK_LIMITS.monthlyExtractions, remaining: FALLBACK_LIMITS.monthlyExtractions, limits: FALLBACK_LIMITS };
  }
  const payload = data as Record<string, unknown>;
  const limits = clampLimits({
    plan: payload.plan,
    monthlyExtractions: payload.limit,
    maxFilesPerBatch: payload.maxFilesPerBatch,
    maxFileBytes: payload.maxFileBytes,
    maxPdfPages: payload.maxPdfPages,
    maxInputChars: payload.maxInputChars,
    extractionsPerHour: FALLBACK_LIMITS.extractionsPerHour,
  });
  return {
    plan: limits.plan,
    used: typeof payload.used === 'number' ? payload.used : 0,
    limit: limits.monthlyExtractions,
    remaining: typeof payload.remaining === 'number' ? payload.remaining : limits.monthlyExtractions,
    limits,
  };
}

/**
 * Generic rate limiter for paths with no user id — the anonymous demo.
 * Returns false when the caller is over the limit.
 */
export async function consumeRateLimit(
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc('consume_rate_limit', {
    p_bucket: bucket,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) {
    logger.error('ratelimit.rpc_failed', { bucket, message: error.message });
    return false; // fail closed
  }
  return data === true;
}
