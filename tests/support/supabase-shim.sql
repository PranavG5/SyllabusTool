-- =========================================================================
-- Minimal stand-in for the pieces of Supabase that the migrations depend on.
-- Used only by tests/rls so the real policies can be exercised against a
-- plain Postgres instance. Mirrors Supabase's own definitions.
-- =========================================================================

create schema if not exists auth;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

do $$ begin create role anon nologin noinherit;          exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin noinherit bypassrls; exception when duplicate_object then null; end $$;

grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;

create table if not exists auth.users (
  id         uuid primary key default extensions.gen_random_uuid(),
  email      text unique,
  created_at timestamptz not null default now()
);

-- Verbatim shape of Supabase's helper: reads the sub claim that PostgREST
-- sets per request via `set_config('request.jwt.claims', ...)`.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;
