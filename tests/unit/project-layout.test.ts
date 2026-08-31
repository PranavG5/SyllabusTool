import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Guards against build-time conventions that fail *silently*.
 *
 * Next.js only picks up middleware from `src/middleware.ts` when the project
 * uses a `src` directory. A copy at the repository root is ignored with no
 * warning, no error, and a successful build — the middleware simply never
 * runs. That shipped to production here: session refresh had never executed,
 * which would have surfaced as students being signed out at random once their
 * access token expired.
 */
describe('Next.js file conventions', () => {
  const usesSrcDir = existsSync('src/app');

  it('keeps the app directory under src/', () => {
    expect(usesSrcDir).toBe(true);
  });

  it('puts middleware where Next.js will actually load it', () => {
    expect(existsSync('src/middleware.ts'), 'src/middleware.ts is missing').toBe(true);
    expect(
      existsSync('middleware.ts'),
      'a root middleware.ts is silently ignored when using a src directory — delete it',
    ).toBe(false);
  });

  it('exports the two things middleware needs to function', () => {
    const source = readFileSync('src/middleware.ts', 'utf8');
    expect(source).toMatch(/export\s+(async\s+)?function\s+middleware\s*\(/);
    expect(source).toMatch(/export\s+const\s+config\s*=/);
  });

  it('does not let middleware run on the calendar feed', () => {
    // Calendar clients poll the feed without cookies; session refresh there is
    // pure latency, and the feed authenticates by token instead.
    expect(readFileSync('src/middleware.ts', 'utf8')).toContain('api/feed');
  });
});

/**
 * A built app should report a middleware bundle. Skipped when `.next` is absent
 * so `npm test` stays fast and offline; CI runs it after `next build`.
 */
describe('build output', () => {
  const manifestPath = '.next/server/middleware-manifest.json';
  const built = existsSync(manifestPath);

  it.skipIf(!built)('registers exactly one middleware in the build', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      middleware?: Record<string, unknown>;
    };
    const entries = Object.keys(manifest.middleware ?? {});
    expect(entries, 'the build produced no middleware — check its location').not.toEqual([]);
    expect(entries).toHaveLength(1);
  });
});
