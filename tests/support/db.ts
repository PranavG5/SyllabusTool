import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, type ClientConfig } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:55432/postgres';

function config(): ClientConfig {
  return { connectionString: TEST_DATABASE_URL };
}

export async function connect(): Promise<Client> {
  const client = new Client(config());
  await client.connect();
  return client;
}

/** True when a Postgres we can run the RLS suite against is reachable. */
export async function databaseAvailable(): Promise<boolean> {
  const client = new Client({ ...config(), connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    await client.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

function migrationFiles(): string[] {
  const dir = join(repoRoot, 'supabase', 'migrations');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => join(dir, f));
}

/**
 * Drops and rebuilds the public schema, then applies the Supabase shim and
 * every real migration in order. The suite therefore tests the migrations
 * that ship, not a hand-written copy of them.
 */
export async function resetSchema(): Promise<void> {
  const client = await connect();
  try {
    await client.query('drop schema if exists public cascade');
    await client.query('create schema public');
    await client.query('drop schema if exists auth cascade');

    await client.query(readFileSync(join(here, 'supabase-shim.sql'), 'utf8'));

    for (const file of migrationFiles()) {
      const sql = readFileSync(file, 'utf8');
      try {
        await client.query(sql);
      } catch (err) {
        throw new Error(`migration ${file.split('/').pop()} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}

/** Creates an auth identity; the on_auth_user_created trigger adds the profile. */
export async function createUser(client: Client, email: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    'insert into auth.users (email) values ($1) returning id',
    [email],
  );
  return rows[0]!.id;
}

export interface AsUserResult<T> {
  rows: T[];
  rowCount: number;
}

/**
 * Runs `fn` inside a transaction that impersonates a signed-in browser
 * client: the `authenticated` Postgres role plus the JWT claim PostgREST
 * would have set. This is the only faithful way to test RLS - a superuser
 * connection bypasses every policy.
 */
export async function asUser<T>(
  userId: string | null,
  fn: (q: (sql: string, params?: unknown[]) => Promise<AsUserResult<Record<string, unknown>>>) => Promise<T>,
  role: 'authenticated' | 'anon' = 'authenticated',
): Promise<T> {
  const client = await connect();
  try {
    await client.query('begin');
    const claims = userId
      ? JSON.stringify({ sub: userId, role })
      : JSON.stringify({ role });
    await client.query('select set_config($1, $2, true)', ['request.jwt.claims', claims]);
    await client.query(`set local role ${role}`);

    const q = async (sql: string, params?: unknown[]) => {
      const res = await client.query(sql, params);
      return { rows: res.rows as Record<string, unknown>[], rowCount: res.rowCount ?? 0 };
    };

    const out = await fn(q);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

/** Asserts a statement is rejected, returning the Postgres error message. */
export async function expectDenied(
  userId: string,
  sql: string,
  params?: unknown[],
): Promise<string> {
  try {
    await asUser(userId, (q) => q(sql, params));
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error(`expected statement to be denied but it succeeded: ${sql}`);
}
