-- =========================================================================
-- Syllabus Tool - Row Level Security
-- =========================================================================
-- Isolation is enforced by Postgres, not by application code. The service
-- role (server-only) bypasses RLS by design; every browser-reachable role
-- (`anon`, `authenticated`) is constrained by the policies below.
--
-- tests/rls/*.test.ts applies these exact migrations to a real Postgres and
-- asserts that user A cannot read, write, or delete user B's rows.
-- =========================================================================

-- -------------------------------------------------------------------------
-- Baseline privileges: start from nothing and grant back deliberately.
-- RLS filters rows; GRANT decides which tables and columns are reachable at
-- all. Both matter - RLS on a table with no policy is a closed door, but a
-- table with a permissive policy and no grant is closed too.
-- -------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant usage on schema public to anon, authenticated;

-- -------------------------------------------------------------------------
-- plan_limits: not user data. Readable so the UI can show real limits.
-- -------------------------------------------------------------------------
grant select on public.plan_limits to anon, authenticated;

drop policy if exists plan_limits_read on public.plan_limits;
create policy plan_limits_read on public.plan_limits
  for select to anon, authenticated
  using (true);

-- -------------------------------------------------------------------------
-- users
-- `plan` and `feed_token` are deliberately NOT updatable by the account
-- owner: self-service plan upgrades would be free money, and the feed token
-- is rotated through public.rotate_feed_token().
-- -------------------------------------------------------------------------
grant select on public.users to authenticated;
grant update (email) on public.users to authenticated;

drop policy if exists users_select_own on public.users;
create policy users_select_own on public.users
  for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists users_update_own on public.users;
create policy users_update_own on public.users
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- -------------------------------------------------------------------------
-- terms
-- -------------------------------------------------------------------------
grant select, insert, update, delete on public.terms to authenticated;

drop policy if exists terms_select_own on public.terms;
create policy terms_select_own on public.terms
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists terms_insert_own on public.terms;
create policy terms_insert_own on public.terms
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists terms_update_own on public.terms;
create policy terms_update_own on public.terms
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists terms_delete_own on public.terms;
create policy terms_delete_own on public.terms
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- -------------------------------------------------------------------------
-- courses
-- The INSERT/UPDATE checks also verify the parent term belongs to the caller,
-- so a user cannot graft a course onto someone else's term.
-- -------------------------------------------------------------------------
grant select, insert, update, delete on public.courses to authenticated;

drop policy if exists courses_select_own on public.courses;
create policy courses_select_own on public.courses
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists courses_insert_own on public.courses;
create policy courses_insert_own on public.courses
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.terms t
       where t.id = term_id and t.user_id = (select auth.uid())
    )
  );

drop policy if exists courses_update_own on public.courses;
create policy courses_update_own on public.courses
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.terms t
       where t.id = term_id and t.user_id = (select auth.uid())
    )
  );

drop policy if exists courses_delete_own on public.courses;
create policy courses_delete_own on public.courses
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- -------------------------------------------------------------------------
-- items
-- Students edit and delete these directly from the review table, so the
-- client gets full CRUD - scoped to their own rows and their own courses.
-- -------------------------------------------------------------------------
grant select, insert, update, delete on public.items to authenticated;

drop policy if exists items_select_own on public.items;
create policy items_select_own on public.items
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists items_insert_own on public.items;
create policy items_insert_own on public.items
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.courses c
       where c.id = course_id and c.user_id = (select auth.uid())
    )
  );

drop policy if exists items_update_own on public.items;
create policy items_update_own on public.items
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.courses c
       where c.id = course_id and c.user_id = (select auth.uid())
    )
  );

drop policy if exists items_delete_own on public.items;
create policy items_delete_own on public.items
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- -------------------------------------------------------------------------
-- uploads
-- Read-only from the browser. Rows are created server-side after the file
-- has passed the size / page-count / parseability gates, so the client
-- cannot register an upload that skipped validation.
-- -------------------------------------------------------------------------
grant select on public.uploads to authenticated;
grant delete on public.uploads to authenticated;

drop policy if exists uploads_select_own on public.uploads;
create policy uploads_select_own on public.uploads
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists uploads_delete_own on public.uploads;
create policy uploads_delete_own on public.uploads
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- -------------------------------------------------------------------------
-- extraction_jobs
-- Read-only from the browser, and deliberately so: monthly quota counts jobs
-- whose status <> 'failed', so a client able to UPDATE its own job status
-- could mark every job failed and extract for free.
-- -------------------------------------------------------------------------
grant select on public.extraction_jobs to authenticated;

drop policy if exists extraction_jobs_select_own on public.extraction_jobs;
create policy extraction_jobs_select_own on public.extraction_jobs
  for select to authenticated
  using (user_id = (select auth.uid()));

-- -------------------------------------------------------------------------
-- usage_events
-- Read-only: these are the billing ledger. Writes are service-role only.
-- -------------------------------------------------------------------------
grant select on public.usage_events to authenticated;

drop policy if exists usage_events_select_own on public.usage_events;
create policy usage_events_select_own on public.usage_events
  for select to authenticated
  using (user_id = (select auth.uid()));

-- -------------------------------------------------------------------------
-- calendar_connections
-- Metadata is readable so the UI can show "Connected to <calendar>", but
-- SELECT on the token columns is revoked at the column level. Even with a
-- valid session and the anon key, ciphertext never leaves the database to a
-- browser client; only the service role can read it.
-- -------------------------------------------------------------------------
grant select (
  id, user_id, provider, google_account_email, google_calendar_id,
  calendar_name, scope, access_token_expires_at, last_synced_at,
  created_at, updated_at
) on public.calendar_connections to authenticated;
grant delete on public.calendar_connections to authenticated;

drop policy if exists calendar_connections_select_own on public.calendar_connections;
create policy calendar_connections_select_own on public.calendar_connections
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists calendar_connections_delete_own on public.calendar_connections;
create policy calendar_connections_delete_own on public.calendar_connections
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- -------------------------------------------------------------------------
-- rate_limits: no browser access at all. RLS is enabled with zero policies,
-- and no grants, so both layers deny.
-- -------------------------------------------------------------------------
revoke all on public.rate_limits from anon, authenticated;

-- -------------------------------------------------------------------------
-- Function execution
-- The security-definer helpers run with the table owner's rights and take a
-- user id as an argument, so exposing them to `authenticated` would be a
-- straight cross-tenant hole (purge_user_data('<someone else>')). They are
-- callable only by the service role.
-- -------------------------------------------------------------------------
revoke all on function public.consume_rate_limit(text, integer, integer)      from public, anon, authenticated;
revoke all on function public.consume_extraction_quota(uuid, integer)         from public, anon, authenticated;
revoke all on function public.get_quota_status(uuid)                          from public, anon, authenticated;
revoke all on function public.purge_job_text(uuid)                            from public, anon, authenticated;
revoke all on function public.list_expired_uploads(integer)                   from public, anon, authenticated;
revoke all on function public.delete_purged_uploads(uuid[])                   from public, anon, authenticated;
revoke all on function public.purge_user_data(uuid)                           from public, anon, authenticated;
revoke all on function public.rotate_feed_token()                             from public, anon, authenticated;

-- Self-scoped: takes no arguments and keys off auth.uid().
grant execute on function public.rotate_feed_token() to authenticated;

-- -------------------------------------------------------------------------
-- Future tables must not silently inherit access.
-- -------------------------------------------------------------------------
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
