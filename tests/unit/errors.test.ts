import { describe, it, expect } from 'vitest';
import { AppError, toClientError } from '@/lib/errors';

/**
 * "Never show a raw stack trace. Every failure state has a written message and
 * a next action." That is a product requirement, so it gets a test.
 */

describe('error serialisation', () => {
  it('gives every AppError a message and a next action', () => {
    const { body } = toClientError(new AppError('quota_exceeded'));
    expect(body.error.message.length).toBeGreaterThan(10);
    expect(body.error.nextAction.length).toBeGreaterThan(10);
    expect(body.error.code).toBe('quota_exceeded');
  });

  it('collapses an unknown throwable to a safe internal error', () => {
    const { status, body } = toClientError(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    expect(status).toBe(500);
    expect(body.error.code).toBe('internal');
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(body)).not.toContain('10.0.0.5');
  });

  it('never serialises a stack trace', () => {
    const err = new Error('boom');
    expect(JSON.stringify(toClientError(err).body)).not.toContain('at ');
    const app = new AppError('internal', { cause: err, context: { dsn: 'postgres://user:pw@host/db' } });
    const serialised = JSON.stringify(toClientError(app).body);
    expect(serialised).not.toContain('postgres://');
    expect(serialised).not.toContain('boom');
  });

  it('keeps diagnostic context off the wire but on the object for logs', () => {
    const app = new AppError('internal', { context: { reason: 'quota check failed' } });
    expect(app.context.reason).toBe('quota check failed');
    expect(JSON.stringify(toClientError(app).body)).not.toContain('quota check failed');
  });

  it('uses sensible HTTP status codes', () => {
    expect(toClientError(new AppError('unauthorized')).status).toBe(401);
    expect(toClientError(new AppError('not_found')).status).toBe(404);
    expect(toClientError(new AppError('rate_limited')).status).toBe(429);
    expect(toClientError(new AppError('quota_exceeded')).status).toBe(429);
    expect(toClientError(new AppError('model_unavailable')).status).toBe(503);
    expect(toClientError(new AppError('invalid_input')).status).toBe(400);
  });

  it('lets a specific message override the catalog default', () => {
    const app = new AppError('file_too_large', { userMessage: '"notes.pdf" is 45 MB.' });
    const { body } = toClientError(app);
    expect(body.error.message).toBe('"notes.pdf" is 45 MB.');
    // The next action still comes from the catalog.
    expect(body.error.nextAction.length).toBeGreaterThan(10);
  });
});

describe('diagnostic fields stay safe', () => {
  it('includes a code, a detail and a reference for the client', () => {
    const { body } = toClientError(
      new AppError('storage_not_configured', {
        detail: 'The "syllabi" storage bucket does not exist on this project.',
      }),
      'K7M2QP',
    );
    expect(body.error.code).toBe('storage_not_configured');
    expect(body.error.detail).toMatch(/bucket does not exist/);
    expect(body.error.reference).toBe('K7M2QP');
  });

  it('still refuses to serialise the cause or the log context', () => {
    const cause = new Error('connect ECONNREFUSED 10.0.0.5:5432');
    const app = new AppError('database_unavailable', {
      detail: 'The database did not answer.',
      cause,
      context: { dsn: 'postgres://user:pw@host/db', serviceKey: 'sb_secret_abc123' },
    });
    const serialised = JSON.stringify(toClientError(app).body);
    expect(serialised).toContain('The database did not answer.');
    for (const secret of ['ECONNREFUSED', '10.0.0.5', 'postgres://', 'sb_secret_abc123', 'at ']) {
      expect(serialised, `leaked ${secret}`).not.toContain(secret);
    }
  });

  it('leaves detail null when nothing specific is known', () => {
    expect(toClientError(new AppError('internal')).body.error.detail).toBeNull();
    expect(toClientError(new Error('boom')).body.error.detail).toBeNull();
  });

  it('generates a distinct, readable reference each time', () => {
    const refs = new Set(Array.from({ length: 200 }, () => toClientError(new AppError('internal')).body.error.reference));
    expect(refs.size).toBeGreaterThan(190);
    for (const ref of refs) {
      expect(ref).toMatch(/^[2-9A-HJ-NP-Z]{6}$/); // no 0/O/1/I to misread aloud
    }
  });

  it('gives the new setup-failure codes an actionable next step', () => {
    for (const code of ['storage_not_configured', 'model_not_configured', 'database_unavailable'] as const) {
      const { body } = toClientError(new AppError(code));
      expect(body.error.message.length, code).toBeGreaterThan(10);
      expect(body.error.nextAction.length, code).toBeGreaterThan(10);
    }
  });
});
