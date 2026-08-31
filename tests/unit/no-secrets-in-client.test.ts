import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "No secrets in the client" is a definition-of-done item, so it is a test
 * rather than a convention.
 *
 * Two layers:
 *  1. Static: no source file that is (or can be) a Client Component may read a
 *     server-only environment variable.
 *  2. Built output: if `.next` exists, scan the shipped client chunks for the
 *     names of every server-only variable.
 */

const SERVER_ONLY_ENV = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'ANTHROPIC_API_KEY',
  'TOKEN_ENCRYPTION_KEY',
  'JOB_WORKER_SECRET',
  'CRON_SECRET',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_CLIENT_ID',
  'SENTRY_AUTH_TOKEN',
];

function walk(dir: string, predicate: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') continue;
      out.push(...walk(path, predicate));
    } else if (predicate(path)) {
      out.push(path);
    }
  }
  return out;
}

describe('server secrets never reach the browser', () => {
  const sourceFiles = walk('src', (p) => p.endsWith('.ts') || p.endsWith('.tsx'));

  it('finds source files to check', () => {
    expect(sourceFiles.length).toBeGreaterThan(20);
  });

  it("no 'use client' module reads a server-only environment variable", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf8');
      if (!/^\s*['"]use client['"]/m.test(content)) continue;
      for (const name of SERVER_ONLY_ENV) {
        if (content.includes(name)) offenders.push(`${file} references ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every module that reads a server secret is marked server-only or is a route", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf8');
      const reads = SERVER_ONLY_ENV.filter((name) => content.includes(`process.env.${name}`));
      if (reads.length === 0) continue;

      const guarded =
        content.includes("import 'server-only'") ||
        /\/route\.ts$/.test(file) ||
        /middleware\.ts$/.test(file);

      if (!guarded) offenders.push(`${file} reads ${reads.join(', ')} without a server-only guard`);
    }
    expect(offenders).toEqual([]);
  });

  it('exposes only NEXT_PUBLIC_ variables to client modules', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf8');
      if (!/^\s*['"]use client['"]/m.test(content)) continue;
      for (const match of content.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
        const name = match[1]!;
        if (!name.startsWith('NEXT_PUBLIC_') && name !== 'NODE_ENV') {
          offenders.push(`${file} reads ${name} in a client component`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // Runs only after `npm run build`; skipped otherwise so `npm test` stays fast.
  const chunkDir = join('.next', 'static', 'chunks');
  const built = existsSync(chunkDir);

  it.skipIf(!built)('no built client chunk mentions a server-only secret', () => {
    const chunks = walk(chunkDir, (p) => p.endsWith('.js'));
    expect(chunks.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const chunk of chunks) {
      const content = readFileSync(chunk, 'utf8');
      for (const name of SERVER_ONLY_ENV) {
        if (content.includes(name)) offenders.push(`${chunk} contains ${name}`);
      }
      // The service-role JWT always carries this claim; a literal match means a
      // real key was inlined even if the variable name was minified away.
      if (content.includes('"role":"service_role"') || content.includes('service_role')) {
        offenders.push(`${chunk} contains a service_role marker`);
      }
      if (/sk-ant-[A-Za-z0-9_-]{10,}/.test(content)) {
        offenders.push(`${chunk} contains something shaped like an Anthropic API key`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it.skipIf(!built)('does not ship the extraction prompt or server pipeline to the browser', () => {
    const chunks = walk(chunkDir, (p) => p.endsWith('.js'));
    const offenders = chunks.filter((c) => {
      const content = readFileSync(c, 'utf8');
      return content.includes('You extract graded work and deadlines');
    });
    expect(offenders).toEqual([]);
  });
});
