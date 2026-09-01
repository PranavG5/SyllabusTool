import { describe, it, expect, vi, afterEach } from 'vitest';
import { postJson } from '@/lib/client-fetch';

/**
 * These cases are the ones that actually reached a user.
 *
 * A 6 MB upload got Vercel's plain-text `Request Entity Too Large`, the old
 * code called response.json() on it before checking response.ok, the resulting
 * SyntaxError fell into the caller's catch, and the student was told to check
 * their internet connection.
 */

function mockFetch(status: number, body: string, ok = status < 400) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, status, text: async () => body })) as unknown as typeof fetch,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('successful responses', () => {
  it('returns parsed JSON', async () => {
    mockFetch(202, JSON.stringify({ jobId: 'abc', totalFiles: 2 }));
    const result = await postJson('/api/extract', {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.jobId).toBe('abc');
  });

  it('tolerates an empty body on a 2xx', async () => {
    mockFetch(204, '');
    const result = await postJson('/api/x', {});
    expect(result.ok).toBe(true);
  });
});

describe('our own error envelope is passed through verbatim', () => {
  it('uses the message and next action the API wrote', async () => {
    mockFetch(429, JSON.stringify({
      error: { code: 'quota_exceeded', message: "You've used all 20 builds.", nextAction: 'Resets on the 1st.' },
    }));
    const result = await postJson('/api/extract', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("You've used all 20 builds.");
      expect(result.error.nextAction).toBe('Resets on the 1st.');
    }
  });
});

describe('platform failures that carry no JSON', () => {
  it('explains an oversized body instead of blaming the connection', async () => {
    mockFetch(413, 'Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE');
    const result = await postJson('/api/extract', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/too much data/i);
      expect(result.error.nextAction).toMatch(/fewer files|paste/i);
      expect(result.error.message).not.toMatch(/connection/i);
    }
  });

  it('explains a timeout', async () => {
    mockFetch(504, '<html><body>An error occurred</body></html>');
    const result = await postJson('/api/extract', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/timed out/i);
  });

  it('tells the student to sign in again on a 401', async () => {
    mockFetch(401, 'Unauthorized');
    const result = await postJson('/api/extract', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/session has expired/i);
  });

  it('does not leak an HTML error page into the message', async () => {
    mockFetch(500, '<!DOCTYPE html><html><head><title>500</title></head><body>stack trace here</body></html>');
    const result = await postJson('/api/extract', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toMatch(/<|DOCTYPE|stack/i);
      expect(result.error.message).toMatch(/on our side/i);
    }
  });

  it('always supplies a next action', async () => {
    for (const [status, body] of [[413, 'too large'], [504, ''], [500, ''], [400, ''], [403, '']] as const) {
      mockFetch(status, body);
      const result = await postJson('/api/x', {});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.nextAction, `status ${status}`).toBeTruthy();
    }
  });
});

describe('a 2xx that is not JSON', () => {
  it('is reported rather than crashing the caller', async () => {
    mockFetch(200, '<html>proxy interstitial</html>');
    const result = await postJson('/api/extract', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/unexpected reply/i);
  });
});
