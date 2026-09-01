import 'server-only';

/**
 * Route helpers. Every route body runs inside `handle`, which guarantees the
 * client sees a written message and a next action rather than a stack trace,
 * whatever goes wrong.
 */

import { NextResponse } from 'next/server';
import { AppError, toClientError, newReference } from '@/lib/errors';
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
    // One reference id shared by the response and the log line, so a
    // screenshot of the error is enough to find the exact failure.
    const reference = newReference();
    const { status, body } = toClientError(err, reference);
    const level = status >= 500 ? 'error' : 'warn';
    logger[level]('http.error', {
      route,
      status,
      reference,
      code: body.error.code,
      detail: body.error.detail,
      durationMs: Date.now() - started,
      ...errorFields(err),
      ...(err instanceof AppError ? { context: err.context } : {}),
    });
    return NextResponse.json(body, {
      status,
      // Readable in the browser's network tab without expanding the body.
      headers: { 'X-Error-Reference': reference, 'X-Error-Code': body.error.code },
    });
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
