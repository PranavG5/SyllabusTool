import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Client } from 'pg';
import { connect, createUser, databaseAvailable, resetSchema } from '../support/db';

/**
 * Quota and rate limiting, verified against the real SQL that enforces them.
 *
 * These run as the table owner (the service role's equivalent) because that is
 * how the application calls them; tests/rls/isolation.test.ts separately proves
 * a browser client cannot call them at all.
 */

const available = await databaseAvailable();
const suite = available ? describe : describe.skip;

let db: Client;

async function newUser(email: string, plan = 'free'): Promise<string> {
  const id = await createUser(db, email);
  await db.query('update public.users set plan = $2 where id = $1', [id, plan]);
  return id;
}

interface Decision {
  allowed: boolean;
  reason?: string;
  used?: number;
  limit?: number;
  limits?: Record<string, number>;
}

async function consume(userId: string, files = 1): Promise<Decision> {
  const { rows } = await db.query<{ result: Decision }>(
    'select public.consume_extraction_quota($1, $2) as result',
    [userId, files],
  );
  return rows[0]!.result;
}

/** Records a job the way the application does after quota is granted. */
async function recordJob(userId: string, status = 'succeeded'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.extraction_jobs (user_id, status, total_files) values ($1, $2, 1) returning id`,
    [userId, status],
  );
  return rows[0]!.id;
}

if (available) {
  beforeAll(async () => {
    await resetSchema();
    db = await connect();
  }, 120_000);
  afterAll(async () => { await db?.end(); });
}

suite('monthly extraction quota', () => {
  it('allows a fresh free-tier user', async () => {
    const user = await newUser('quota-fresh@example.edu');
    const d = await consume(user);
    expect(d.allowed).toBe(true);
    expect(d.used).toBe(0);
    expect(d.limit).toBe(20);
  });

  it('refuses once the monthly limit is reached', async () => {
    const user = await newUser('quota-full@example.edu');
    for (let i = 0; i < 20; i += 1) await recordJob(user);
    const d = await consume(user);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('monthly_quota_exceeded');
    expect(d.used).toBe(20);
  });

  it('allows the twentieth build but not the twenty-first', async () => {
    const user = await newUser('quota-edge@example.edu');
    for (let i = 0; i < 19; i += 1) await recordJob(user);
    expect((await consume(user)).allowed).toBe(true);
    await recordJob(user);
    expect((await consume(user)).allowed).toBe(false);
  });

  it('does not charge quota for a job that failed outright', async () => {
    const user = await newUser('quota-failed@example.edu');
    for (let i = 0; i < 25; i += 1) await recordJob(user, 'failed');
    const d = await consume(user);
    expect(d.allowed).toBe(true);
    expect(d.used).toBe(0);
  });

  it('counts a partial success against quota', async () => {
    const user = await newUser('quota-partial@example.edu');
    await recordJob(user, 'partial');
    expect((await consume(user)).used).toBe(1);
  });

  it('ignores jobs from a previous month', async () => {
    const user = await newUser('quota-lastmonth@example.edu');
    for (let i = 0; i < 20; i += 1) await recordJob(user);
    await db.query(
      `update public.extraction_jobs set created_at = now() - interval '2 months' where user_id = $1`,
      [user],
    );
    const d = await consume(user);
    expect(d.allowed).toBe(true);
    expect(d.used).toBe(0);
  });

  it('does not let one user consume another user\'s quota', async () => {
    const a = await newUser('quota-a@example.edu');
    const b = await newUser('quota-b@example.edu');
    for (let i = 0; i < 20; i += 1) await recordJob(a);
    expect((await consume(a)).allowed).toBe(false);
    expect((await consume(b)).allowed).toBe(true);
  });

  it('refuses a user with no profile row', async () => {
    const d = await consume('00000000-0000-4000-8000-000000000000');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('no_account');
  });
});

suite('a paid tier is a data change, not a code change', () => {
  it('gives a pro user the higher limits with no code path of its own', async () => {
    const user = await newUser('quota-pro@example.edu', 'pro');
    for (let i = 0; i < 20; i += 1) await recordJob(user);
    const d = await consume(user);
    expect(d.allowed).toBe(true);
    expect(d.limit).toBe(500);
    expect(d.limits?.maxFilesPerBatch).toBe(25);
  });

  it('picks up a brand-new tier inserted at runtime', async () => {
    await db.query(
      `insert into public.plan_limits
         (plan, monthly_extractions, max_files_per_batch, max_file_bytes, max_pdf_pages, extractions_per_hour, max_input_chars)
       values ('team', 5000, 50, 104857600, 500, 200, 5000000)
       on conflict (plan) do nothing`,
    );
    const user = await newUser('quota-team@example.edu');
    await db.query(`update public.users set plan = 'team' where id = $1`, [user]);
    const d = await consume(user);
    expect(d.allowed).toBe(true);
    expect(d.limit).toBe(5000);
  });
});

suite('per-batch file cap', () => {
  it('refuses more files than the plan allows', async () => {
    const user = await newUser('quota-files@example.edu');
    const d = await consume(user, 11);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('too_many_files');
    expect(d.limit).toBe(10);
  });

  it('allows exactly the plan maximum', async () => {
    const user = await newUser('quota-files-ok@example.edu');
    expect((await consume(user, 10)).allowed).toBe(true);
  });

  it('does not charge quota or rate limit for a rejected batch', async () => {
    const user = await newUser('quota-files-nocharge@example.edu');
    for (let i = 0; i < 12; i += 1) await consume(user, 99);
    // Rate limit is 10/hour; twelve rejected batches must not have used any.
    expect((await consume(user, 1)).allowed).toBe(true);
  });
});

suite('hourly rate limit', () => {
  it('refuses the eleventh build in an hour', async () => {
    const user = await newUser('rate-burst@example.edu');
    for (let i = 0; i < 10; i += 1) {
      expect((await consume(user)).allowed, `call ${i + 1} should be allowed`).toBe(true);
    }
    const d = await consume(user);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('rate_limited');
  });

  it('counts each user separately', async () => {
    const a = await newUser('rate-a@example.edu');
    const b = await newUser('rate-b@example.edu');
    for (let i = 0; i < 10; i += 1) await consume(a);
    expect((await consume(a)).allowed).toBe(false);
    expect((await consume(b)).allowed).toBe(true);
  });

  it('is atomic under concurrency', async () => {
    const user = await newUser('rate-concurrent@example.edu');
    // Twenty simultaneous requests against a limit of ten. Without the
    // advisory lock and the atomic upsert, more than ten slip through.
    const clients = await Promise.all(Array.from({ length: 20 }, () => connect()));
    try {
      const results = await Promise.all(
        clients.map((c) =>
          c
            .query<{ result: Decision }>('select public.consume_extraction_quota($1, 1) as result', [user])
            .then((r) => r.rows[0]!.result.allowed),
        ),
      );
      expect(results.filter(Boolean).length).toBe(10);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  it('opens a new window as time passes', async () => {
    const user = await newUser('rate-window@example.edu');
    for (let i = 0; i < 10; i += 1) await consume(user);
    expect((await consume(user)).allowed).toBe(false);
    // Age the current window out rather than waiting an hour.
    await db.query(
      `update public.rate_limits set window_start = window_start - interval '2 hours' where bucket = $1`,
      [`extract:user:${user}`],
    );
    expect((await consume(user)).allowed).toBe(true);
  });
});

suite('generic rate limiter', () => {
  it('allows exactly `limit` calls per window', async () => {
    const results: boolean[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { rows } = await db.query<{ ok: boolean }>(
        'select public.consume_rate_limit($1, 3, 3600) as ok',
        ['demo:ip:test'],
      );
      results.push(rows[0]!.ok);
    }
    expect(results).toEqual([true, true, true, false, false]);
  });

  it('rejects a nonsensical limit rather than allowing everything', async () => {
    await expect(
      db.query('select public.consume_rate_limit($1, 0, 3600)', ['demo:ip:bad']),
    ).rejects.toThrow(/must be positive/i);
  });
});

suite('quota status read model', () => {
  it('reports the same numbers the gate uses', async () => {
    const user = await newUser('status@example.edu');
    for (let i = 0; i < 3; i += 1) await recordJob(user);
    const { rows } = await db.query<{ result: Record<string, unknown> }>(
      'select public.get_quota_status($1) as result',
      [user],
    );
    expect(rows[0]!.result).toMatchObject({ plan: 'free', used: 3, limit: 20, remaining: 17 });
  });
});
