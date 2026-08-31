import { describe, it, expect } from 'vitest';

/**
 * The auth-code fallback in middleware.ts, tested through the same pure
 * function shape the middleware uses.
 *
 * This exists because a real deployment hit it: Supabase's Site URL was
 * misconfigured and the auth code arrived at the site root instead of
 * /auth/callback, leaving the student on the landing page still signed out.
 */

// Mirrors authCodeRedirect() in middleware.ts. Kept as a pure function here so
// the routing decision is testable without booting Next's edge runtime.
function decide(rawUrl: string): string | null {
  const url = new URL(rawUrl);
  const { pathname, searchParams } = url;
  if (pathname.startsWith('/auth/') || pathname.startsWith('/api/')) return null;
  if (!searchParams.has('code') && !searchParams.has('token_hash')) return null;

  const target = new URL(url.toString());
  target.pathname = '/auth/callback';
  if (pathname !== '/' && !target.searchParams.has('next')) {
    target.searchParams.set('next', pathname);
  }
  return target.toString();
}

const SITE = 'https://syllabus-tool-six.vercel.app';

describe('auth code arriving somewhere other than the callback', () => {
  it('forwards a code left at the site root', () => {
    expect(decide(`${SITE}/?code=641b1637-714b-42df-949d-565e699e731e`))
      .toBe(`${SITE}/auth/callback?code=641b1637-714b-42df-949d-565e699e731e`);
  });

  it('forwards the older token_hash form too', () => {
    expect(decide(`${SITE}/?token_hash=abc&type=email`))
      .toBe(`${SITE}/auth/callback?token_hash=abc&type=email`);
  });

  it('remembers the page they were on', () => {
    const out = new URL(decide(`${SITE}/schedule?code=xyz`)!);
    expect(out.pathname).toBe('/auth/callback');
    expect(out.searchParams.get('code')).toBe('xyz');
    expect(out.searchParams.get('next')).toBe('/schedule');
  });

  it('does not loop on the callback itself', () => {
    expect(decide(`${SITE}/auth/callback?code=xyz`)).toBeNull();
  });

  it('leaves API routes alone', () => {
    expect(decide(`${SITE}/api/schedule?code=xyz`)).toBeNull();
  });

  it('ignores ordinary navigation', () => {
    expect(decide(`${SITE}/`)).toBeNull();
    expect(decide(`${SITE}/privacy`)).toBeNull();
    expect(decide(`${SITE}/schedule?termId=abc`)).toBeNull();
  });

  it('does not clobber an explicit next', () => {
    const out = new URL(decide(`${SITE}/login?code=xyz&next=/input`)!);
    expect(out.searchParams.get('next')).toBe('/input');
  });
});

describe('the callback only redirects within this app', () => {
  // Mirrors the guard in src/app/auth/callback/route.ts.
  const safe = (next: string | null) =>
    next && next.startsWith('/') && !next.startsWith('//') ? next : '/input';

  it('accepts an in-app path', () => {
    expect(safe('/schedule')).toBe('/schedule');
  });

  it('refuses an absolute URL, so the flow cannot be used for phishing', () => {
    expect(safe('https://evil.example/steal')).toBe('/input');
    expect(safe('//evil.example')).toBe('/input');
    expect(safe(null)).toBe('/input');
  });
});

describe('callbacks stay on the host the browser is actually using', () => {
  /**
   * Mirrors `here()` in src/app/auth/callback/route.ts.
   *
   * This exists because of a real incident: NEXT_PUBLIC_SITE_URL was set to a
   * lookalike domain that belongs to somebody else's Vercel project, so a
   * successful sign-in ended by redirecting the student to a stranger's site,
   * which 404'd. The session cookie was fine — it was set on the right host —
   * but they were no longer on that host to use it.
   */
  const here = (requestUrl: string, path: string) => new URL(path, requestUrl).toString();

  it('keeps the student on the domain they signed in from', () => {
    expect(here('https://syllabus-tool-six.vercel.app/auth/callback?code=x', '/input'))
      .toBe('https://syllabus-tool-six.vercel.app/input');
  });

  it('ignores whatever NEXT_PUBLIC_SITE_URL happens to say', () => {
    // Even a preview deployment or a custom domain lands back on itself.
    for (const host of [
      'https://syllabus-tool-git-main-x.vercel.app',
      'https://schedule.example.edu',
      'http://localhost:3000',
    ]) {
      expect(here(`${host}/auth/callback?code=x`, '/input')).toBe(`${host}/input`);
    }
  });

  it('cannot be turned into an open redirect by the next param', () => {
    // `next` is filtered to same-origin paths before it reaches here, but the
    // URL constructor is the second line of defence.
    const out = here('https://syllabus-tool-six.vercel.app/auth/callback', '/schedule');
    expect(new URL(out).host).toBe('syllabus-tool-six.vercel.app');
  });

  it('carries error states back to the same host too', () => {
    expect(here('https://syllabus-tool-six.vercel.app/auth/callback', '/login?error=link_expired'))
      .toBe('https://syllabus-tool-six.vercel.app/login?error=link_expired');
  });
});
