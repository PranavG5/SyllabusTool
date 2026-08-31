import 'server-only';

/**
 * Route helpers. Every route body runs inside `handle`, which guarantees the
 * client sees a written message and a next action rather than a stack trace,
 * whatever goes wrong.
 */

import { NextResponse } from 'next/server';
import { AppError, toClientError } from '@/lib/errors';
import { logger, errorFields } from '@/lib/logger';
import { getCurrentUser, type AuthedUser } from '@/lib/supabase/server';

export function json<T>(body: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(body, init);
}

export async function handle(
  route: string,
  fn: () => Promise<NextResponse>,
): Promise<NextResponse> {
  const started = Date.now();
  try {
    const response = await fn();
    logger.info('http.ok', { route, status: response.status, durationMs: Date.now() - started });
    return response;
  } catch (err) {
    const { status, body } = toClientError(err);
    const level = status >= 500 ? 'error' : 'warn';
    logger[level]('http.error', {
      route,
      status,
      code: body.error.code,
      durationMs: Date.now() - started,
      ...errorFields(err),
      ...(err instanceof AppError ? { context: err.context } : {}),
    });
    return NextResponse.json(body, { status });
  }
}

/** Throws `unauthorized` rather than returning null, so routes fail closed. */
export async function requireUser(): Promise<AuthedUser> {
  const user = await getCurrentUser();
  if (!user) throw new AppError('unauthorized');
  return user;
}

/** Best-effort client IP for anonymous rate limiting. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}

export function siteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) return configured.replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000';
}
