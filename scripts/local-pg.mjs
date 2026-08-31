#!/usr/bin/env node
/**
 * Starts / stops a throwaway PostgreSQL for `npm run test:rls`.
 *
 * The RLS suite needs a real Postgres because RLS is the thing under test;
 * there is no faithful way to fake it. Any empty database works - point
 * TEST_DATABASE_URL at your own instance and skip this script entirely.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

const PORT = process.env.TEST_PG_PORT ?? '55432';
const PGDATA = process.env.TEST_PG_DATA ?? '/var/lib/postgresql/testdata';

function findBin() {
  for (const dir of ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/opt/homebrew/bin']) {
    if (existsSync(`${dir}/pg_ctl`)) return dir;
  }
  const which = spawnSync('which', ['pg_ctl'], { encoding: 'utf8' });
  if (which.status === 0) return which.stdout.trim().replace(/\/pg_ctl$/, '');
  throw new Error('pg_ctl not found. Install PostgreSQL or set TEST_DATABASE_URL.');
}

const bin = findBin();
const asPostgres = process.getuid?.() === 0;
const run = (cmd, args) =>
  asPostgres
    ? execFileSync('su', ['postgres', '-c', [cmd, ...args].join(' ')], { stdio: 'inherit' })
    : execFileSync(cmd, args, { stdio: 'inherit' });

const cmd = process.argv[2] ?? 'up';

if (cmd === 'up') {
  if (!existsSync(`${PGDATA}/PG_VERSION`)) {
    mkdirSync(PGDATA, { recursive: true });
    if (asPostgres) execFileSync('chown', ['-R', 'postgres:postgres', PGDATA]);
    run(`${bin}/initdb`, ['-D', PGDATA, '-U', 'postgres', '--auth=trust', '-E', 'UTF8']);
  }
  run(`${bin}/pg_ctl`, [
    '-D', PGDATA,
    '-o', `"-p ${PORT} -k /tmp -c listen_addresses=127.0.0.1"`,
    '-l', `${PGDATA}/server.log`,
    '-w', '-t', '30', 'start',
  ]);
  console.log(`postgres listening on 127.0.0.1:${PORT}`);
} else if (cmd === 'down') {
  run(`${bin}/pg_ctl`, ['-D', PGDATA, '-m', 'fast', 'stop']);
} else {
  console.error(`unknown command: ${cmd} (expected "up" or "down")`);
  process.exit(1);
}
