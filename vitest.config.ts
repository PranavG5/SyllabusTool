import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // `server-only` throws on import unless the bundler resolves the
      // `react-server` export condition. Tests import server modules directly,
      // so point it at the package's own no-op entry by path — the subpath is
      // not in its exports map, so it cannot be aliased by specifier.
      'server-only': fileURLToPath(new URL('./node_modules/server-only/empty.js', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // The RLS suite shares one Postgres schema; run files serially so
    // fixtures from different suites cannot interleave.
    fileParallelism: false,
  },
});
