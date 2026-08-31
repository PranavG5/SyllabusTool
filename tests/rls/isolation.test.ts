import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Client } from 'pg';
import { asUser, connect, createUser, databaseAvailable, expectDenied, resetSchema, TEST_DATABASE_URL } from '../support/db';

/**
 * Row Level Security, verified against a real PostgreSQL running the real
 * migrations. There is no faithful way to fake this: RLS is enforced by the
 * database, so the database is what has to be tested.
 *
 * Every query in `asUser` runs as the `authenticated` role with the JWT claim
 * PostgREST would have set — the same conditions a browser client hits.
 */

const available = await databaseAvailable();
const suite = available ? describe : describe.skip;

if (!available) {
  console.warn(
    `\n[rls] skipped: no Postgres at ${TEST_DATABASE_URL}.\n` +
      `      Start one with \`npm run db:test:up\`, or point TEST_DATABASE_URL at your own.\n`,
  );
}

interface Fixture {
  alice: string;
  bob: string;
  aliceTerm: string;
  bobTerm: string;
  aliceCourse: string;
  bobCourse: string;
  aliceItem: string;
  bobItem: string;
  aliceUpload: string;
  aliceJob: string;
}

let admin: Client;
let f: Fixture;

async function seed(): Promise<Fixture> {
  const alice = await createUser(admin, 'alice@example.edu');
  const bob = await createUser(admin, 'bob@example.edu');

  const mk = async (userId: string) => {
    const { rows: [term] } = await admin.query<{ id: string }>(
      `insert into public.terms (user_id, name, timezone, start_date, end_date)
       values ($1, 'Fall 2026', 'America/New_York', '2026-08-24', '2026-12-11') returning id`,
      [userId],
    );
    const { rows: [course] } = await admin.query<{ id: string }>(
      `insert into public.courses (user_id, term_id, code, name, meeting_days)
       values ($1, $2, $3, 'A course', '{1,3,5}') returning id`,
      [userId, term!.id, `CS ${Math.floor(Math.random() * 9000) + 1000}`],
    );
    const { rows: [item] } = await admin.query<{ id: string }>(
      `insert into public.items (user_id, term_id, course_id, title, type, due_date, due_time, source_snippet, confidence)
       values ($1, $2, $3, 'Problem Set 1', 'assignment', '2026-09-04', '23:59', 'PS1 due Sep 4', 'high') returning id`,
      [userId, term!.id, course!.id],
    );
    return { term: term!.id, course: course!.id, item: item!.id };
  };

  const a = await mk(alice);
  const b = await mk(bob);

  const { rows: [job] } = await admin.query<{ id: string }>(
    `insert into public.extraction_jobs (user_id, term_id, status, total_files)
     values ($1, $2, 'succeeded', 1) returning id`,
    [alice, a.term],
  );
  const { rows: [upload] } = await admin.query<{ id: string }>(
    `insert into public.uploads (user_id, job_id, storage_path, filename, mime_type, size_bytes, extracted_text)
     values ($1, $2, $3, 'syllabus.pdf', 'application/pdf', 1234, 'secret text') returning id`,
    [alice, job!.id, `${alice}/${job!.id}/syllabus.pdf`],
  );
  await admin.query(
    `insert into public.usage_events (user_id, job_id, kind, model, input_tokens, output_tokens, cost_usd)
     values ($1, $2, 'extraction', 'claude-opus-5', 1000, 200, 0.01)`,
    [alice, job!.id],
  );
  await admin.query(
    `insert into public.calendar_connections (user_id, refresh_token_encrypted, google_calendar_id, calendar_name)
     values ($1, 'ciphertext-alice', 'cal-alice', 'Fall 2026 — Coursework')`,
    [alice],
  );

  return {
    alice, bob,
    aliceTerm: a.term, bobTerm: b.term,
    aliceCourse: a.course, bobCourse: b.course,
    aliceItem: a.item, bobItem: b.item,
    aliceUpload: upload!.id, aliceJob: job!.id,
  };
}

if (available) {
  beforeAll(async () => {
    await resetSchema();
    admin = await connect();
    f = await seed();
  }, 120_000);

  afterAll(async () => {
    await admin?.end();
  });
}

// ---------------------------------------------------------------------------

suite('RLS is switched on everywhere', () => {
  it('enables row level security on every table in public', async () => {
    const { rows } = await admin.query<{ tablename: string; rowsecurity: boolean }>(
      `select tablename, rowsecurity from pg_tables where schemaname = 'public' order by tablename`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(9);
    const unprotected = rows.filter((r) => !r.rowsecurity).map((r) => r.tablename);
    expect(unprotected, 'tables without RLS').toEqual([]);
  });

  it('gives every user-data table at least one policy', async () => {
    const { rows } = await admin.query<{ tablename: string; n: string }>(
      `select t.tablename, count(p.policyname) as n
         from pg_tables t
         left join pg_policies p on p.schemaname = t.schemaname and p.tablename = t.tablename
        where t.schemaname = 'public'
        group by t.tablename order by t.tablename`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.tablename, Number(r.n)]));
    for (const table of ['users', 'terms', 'courses', 'items', 'uploads', 'extraction_jobs', 'usage_events', 'calendar_connections']) {
      expect(byName[table], `${table} has no policy`).toBeGreaterThan(0);
    }
    // rate_limits is deliberately unreachable: RLS on, zero policies, no grants.
    expect(byName['rate_limits']).toBe(0);
  });
});

suite('SECURITY DEFINER functions are not reachable from a browser', () => {
  /**
   * Supabase exposes every function in `public` as `/rest/v1/rpc/<name>`, so a
   * SECURITY DEFINER function with an EXECUTE grant is a direct escalation
   * path. The trap: `revoke ... from anon, authenticated` does NOT remove the
   * EXECUTE that PostgreSQL grants to the pseudo-role PUBLIC, which those
   * roles inherit. Supabase's own advisor caught handle_new_auth_user leaking
   * that way on the deployed database; this test is why it cannot recur.
   */
  const DELIBERATELY_CALLABLE = new Set(['rotate_feed_token']);

  it('exposes no definer function to anon, and only the self-scoped one to authenticated', async () => {
    const { rows } = await admin.query<{
      proname: string; secdef: boolean; anon_exec: boolean; auth_exec: boolean;
    }>(
      `select p.proname,
              p.prosecdef as secdef,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
        order by p.proname`,
    );

    expect(rows.length).toBeGreaterThan(5);

    const anonReachable = rows.filter((r) => r.anon_exec).map((r) => r.proname);
    expect(anonReachable, 'anon can execute these').toEqual([]);

    const authReachable = rows.filter((r) => r.auth_exec).map((r) => r.proname);
    for (const name of authReachable) {
      expect(DELIBERATELY_CALLABLE.has(name), `${name} is callable by signed-in users`).toBe(true);
    }
  });

  it('keeps every account-scoped helper unreachable by name', async () => {
    for (const fn of [
      'consume_extraction_quota', 'consume_rate_limit', 'get_quota_status',
      'purge_user_data', 'purge_job_text', 'list_expired_uploads',
      'delete_purged_uploads', 'handle_new_auth_user',
    ]) {
      const { rows } = await admin.query<{ anon_exec: boolean; auth_exec: boolean }>(
        `select has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1`,
        [fn],
      );
      expect(rows.length, `${fn} is missing`).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.anon_exec, `anon can execute ${fn}`).toBe(false);
        expect(row.auth_exec, `authenticated can execute ${fn}`).toBe(false);
      }
    }
  });
});

suite('a user cannot read another user\'s rows', () => {
  it('sees only their own terms', async () => {
    const rows = await asUser(f.alice, (q) => q('select id from public.terms'));
    expect(rows.rows.map((r) => r.id)).toEqual([f.aliceTerm]);
  });

  it('sees only their own courses', async () => {
    const rows = await asUser(f.bob, (q) => q('select id from public.courses'));
    expect(rows.rows.map((r) => r.id)).toEqual([f.bobCourse]);
  });

  it('sees only their own items', async () => {
    const rows = await asUser(f.alice, (q) => q('select id from public.items'));
    expect(rows.rows.map((r) => r.id)).toEqual([f.aliceItem]);
  });

  it('cannot read a specific row belonging to someone else', async () => {
    const rows = await asUser(f.bob, (q) => q('select id from public.items where id = $1', [f.aliceItem]));
    expect(rows.rowCount).toBe(0);
  });

  it('sees only their own uploads, jobs and usage events', async () => {
    const uploads = await asUser(f.bob, (q) => q('select id from public.uploads'));
    const jobs = await asUser(f.bob, (q) => q('select id from public.extraction_jobs'));
    const usage = await asUser(f.bob, (q) => q('select id from public.usage_events'));
    expect(uploads.rowCount).toBe(0);
    expect(jobs.rowCount).toBe(0);
    expect(usage.rowCount).toBe(0);
  });

  it('sees only their own profile row', async () => {
    const rows = await asUser(f.alice, (q) => q('select id from public.users'));
    expect(rows.rows.map((r) => r.id)).toEqual([f.alice]);
  });

  it('cannot read anything at all when unauthenticated', async () => {
    // `anon` holds no grant on the user-data tables, so this is refused at the
    // privilege layer before RLS is even consulted — a stronger outcome than
    // an empty result set, and one less thing depending on policy correctness.
    let denied = false;
    try {
      await asUser(null, (q) => q('select id from public.items'), 'anon');
    } catch (err) {
      denied = /permission denied/i.test((err as Error).message);
    }
    expect(denied, 'anon should be refused outright').toBe(true);

    for (const table of ['terms', 'courses', 'uploads', 'extraction_jobs', 'usage_events', 'users']) {
      await expect(
        asUser(null, (q) => q(`select 1 from public.${table}`), 'anon'),
        `anon reached ${table}`,
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it('leaks nothing through a join', async () => {
    const rows = await asUser(f.bob, (q) =>
      q(`select i.id from public.items i join public.courses c on c.id = i.course_id`),
    );
    expect(rows.rows.map((r) => r.id)).toEqual([f.bobItem]);
  });

  it('leaks nothing through an aggregate', async () => {
    const rows = await asUser(f.bob, (q) => q('select count(*)::int as n from public.items'));
    expect(rows.rows[0]!.n).toBe(1);
  });
});

suite('a user cannot write to another user\'s rows', () => {
  it('cannot update someone else\'s item', async () => {
    const res = await asUser(f.bob, (q) =>
      q('update public.items set title = $1 where id = $2', ['hijacked', f.aliceItem]),
    );
    expect(res.rowCount).toBe(0);
    const { rows } = await admin.query('select title from public.items where id = $1', [f.aliceItem]);
    expect(rows[0]!.title).toBe('Problem Set 1');
  });

  it('cannot delete someone else\'s item', async () => {
    const res = await asUser(f.bob, (q) => q('delete from public.items where id = $1', [f.aliceItem]));
    expect(res.rowCount).toBe(0);
    const { rowCount } = await admin.query('select 1 from public.items where id = $1', [f.aliceItem]);
    expect(rowCount).toBe(1);
  });

  it('cannot insert a row owned by someone else', async () => {
    const message = await expectDenied(
      f.bob,
      `insert into public.items (user_id, term_id, course_id, title, type, source_snippet)
       values ($1, $2, $3, 'planted', 'assignment', 'x')`,
      [f.alice, f.aliceTerm, f.aliceCourse],
    );
    expect(message).toMatch(/row-level security/i);
  });

  it('cannot attach its own item to someone else\'s course', async () => {
    const message = await expectDenied(
      f.bob,
      `insert into public.items (user_id, term_id, course_id, title, type, source_snippet)
       values ($1, $2, $3, 'planted', 'assignment', 'x')`,
      [f.bob, f.aliceTerm, f.aliceCourse],
    );
    expect(message).toMatch(/row-level security/i);
  });

  it('cannot attach its own course to someone else\'s term', async () => {
    const message = await expectDenied(
      f.bob,
      `insert into public.courses (user_id, term_id, code) values ($1, $2, 'EVIL 101')`,
      [f.bob, f.aliceTerm],
    );
    expect(message).toMatch(/row-level security/i);
  });

  it('cannot move its own item onto someone else\'s course by UPDATE', async () => {
    const message = await expectDenied(
      f.bob,
      'update public.items set course_id = $1 where id = $2',
      [f.aliceCourse, f.bobItem],
    );
    expect(message).toMatch(/row-level security/i);
  });

  it('cannot re-own its own row to another user', async () => {
    const message = await expectDenied(
      f.bob,
      'update public.items set user_id = $1 where id = $2',
      [f.alice, f.bobItem],
    );
    expect(message).toMatch(/row-level security/i);
  });

  it('can fully manage its own items', async () => {
    const created = await asUser(f.bob, (q) =>
      q(
        `insert into public.items (user_id, term_id, course_id, title, type, due_date, source_snippet)
         values ($1, $2, $3, 'Mine', 'quiz', '2026-10-01', 'snippet') returning id`,
        [f.bob, f.bobTerm, f.bobCourse],
      ),
    );
    const id = created.rows[0]!.id as string;
    const updated = await asUser(f.bob, (q) => q('update public.items set title = $1 where id = $2', ['Mine v2', id]));
    expect(updated.rowCount).toBe(1);
    const deleted = await asUser(f.bob, (q) => q('delete from public.items where id = $1', [id]));
    expect(deleted.rowCount).toBe(1);
  });
});

suite('privilege escalation is blocked', () => {
  it('cannot upgrade its own plan', async () => {
    const message = await expectDenied(f.bob, `update public.users set plan = 'pro' where id = $1`, [f.bob]);
    expect(message).toMatch(/permission denied|column/i);
    const { rows } = await admin.query('select plan from public.users where id = $1', [f.bob]);
    expect(rows[0]!.plan).toBe('free');
  });

  it('cannot set its own feed token', async () => {
    const message = await expectDenied(f.bob, `update public.users set feed_token = 'chosen' where id = $1`, [f.bob]);
    expect(message).toMatch(/permission denied|column/i);
  });

  it('rotates its own feed token through the function, and only its own', async () => {
    const { rows: before } = await admin.query('select feed_token from public.users where id = $1', [f.bob]);
    const rotated = await asUser(f.bob, (q) => q('select public.rotate_feed_token() as token'));
    const { rows: after } = await admin.query('select feed_token from public.users where id in ($1,$2) order by id', [f.alice, f.bob]);
    expect(rotated.rows[0]!.token).not.toBe(before[0]!.feed_token);
    expect(after.map((r) => r.feed_token)).toContain(rotated.rows[0]!.token);
    // Alice's token is untouched.
    const { rows: aliceAfter } = await admin.query('select feed_token from public.users where id = $1', [f.alice]);
    expect(aliceAfter[0]!.feed_token).not.toBe(rotated.rows[0]!.token);
  });

  it('cannot mark its own extraction job failed to dodge quota', async () => {
    const message = await expectDenied(
      f.alice,
      `update public.extraction_jobs set status = 'failed' where id = $1`,
      [f.aliceJob],
    );
    expect(message).toMatch(/permission denied/i);
  });

  it('cannot forge a usage event', async () => {
    const message = await expectDenied(
      f.alice,
      `insert into public.usage_events (user_id, kind, cost_usd) values ($1, 'extraction', 0)`,
      [f.alice],
    );
    expect(message).toMatch(/permission denied/i);
  });

  it('cannot call the quota function directly', async () => {
    const message = await expectDenied(f.bob, 'select public.consume_extraction_quota($1, 1)', [f.bob]);
    expect(message).toMatch(/permission denied/i);
  });

  it('cannot purge another user through the admin function', async () => {
    const message = await expectDenied(f.bob, 'select public.purge_user_data($1)', [f.alice]);
    expect(message).toMatch(/permission denied/i);
    const { rowCount } = await admin.query('select 1 from public.users where id = $1', [f.alice]);
    expect(rowCount).toBe(1);
  });

  it('cannot grant itself rate-limit headroom', async () => {
    const message = await expectDenied(f.bob, `select public.consume_rate_limit('x', 999999, 3600)`);
    expect(message).toMatch(/permission denied/i);
  });

  it('cannot touch the rate_limits table at all', async () => {
    const message = await expectDenied(f.bob, 'select * from public.rate_limits');
    expect(message).toMatch(/permission denied/i);
  });
});

suite('OAuth tokens are unreadable from the browser', () => {
  it('refuses SELECT on the encrypted token columns even for the owner', async () => {
    const message = await expectDenied(f.alice, 'select refresh_token_encrypted from public.calendar_connections');
    expect(message).toMatch(/permission denied/i);
  });

  it('refuses a SELECT * that would sweep the token columns in', async () => {
    const message = await expectDenied(f.alice, 'select * from public.calendar_connections');
    expect(message).toMatch(/permission denied/i);
  });

  it('still lets the owner read the connection metadata', async () => {
    const rows = await asUser(f.alice, (q) =>
      q('select calendar_name, google_calendar_id from public.calendar_connections'),
    );
    expect(rows.rows[0]!.calendar_name).toBe('Fall 2026 — Coursework');
  });

  it('shows another user nothing', async () => {
    const rows = await asUser(f.bob, (q) => q('select calendar_name from public.calendar_connections'));
    expect(rows.rowCount).toBe(0);
  });

  it('lets the owner disconnect, and no one else', async () => {
    const other = await asUser(f.bob, (q) => q('delete from public.calendar_connections'));
    expect(other.rowCount).toBe(0);
    const { rowCount } = await admin.query('select 1 from public.calendar_connections where user_id = $1', [f.alice]);
    expect(rowCount).toBe(1);
  });
});

suite('plan limits are readable but not writable', () => {
  it('lets a signed-in user read the limits so the UI can show them', async () => {
    const rows = await asUser(f.alice, (q) => q('select plan, monthly_extractions from public.plan_limits order by plan'));
    expect(rows.rows.map((r) => r.plan)).toEqual(['free', 'pro']);
  });

  it('refuses to let a user raise their own limits', async () => {
    const message = await expectDenied(f.alice, `update public.plan_limits set monthly_extractions = 999999 where plan = 'free'`);
    expect(message).toMatch(/permission denied/i);
  });
});
