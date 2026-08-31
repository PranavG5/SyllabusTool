-- =========================================================================
-- Syllabus Tool - core schema
-- =========================================================================
-- Every table in this file carries Row Level Security. Policies live in
-- 0003_rls.sql; the tables are created with RLS enabled here so that a
-- migration ordering mistake fails closed (no policies == no access) rather
-- than open.
-- =========================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- -------------------------------------------------------------------------
-- Enums
-- -------------------------------------------------------------------------
do $$ begin
  create type public.item_type as enum ('assignment','quiz','exam','project','reading','other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.confidence_level as enum ('high','medium','low');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.item_status as enum ('active','dismissed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.job_status as enum ('queued','running','succeeded','partial','failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.upload_status as enum ('pending','parsed','failed','skipped');
exception when duplicate_object then null; end $$;

-- -------------------------------------------------------------------------
-- Shared trigger helpers
-- -------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Bumps a monotonic revision counter on every material change. Exported as
-- the ICS SEQUENCE property so that re-importing a feed updates the existing
-- event instead of creating a duplicate.
create or replace function public.bump_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  if (new.title, new.type, new.due_date, new.due_time, new.location, new.status, new.course_id)
     is distinct from
     (old.title, old.type, old.due_date, old.due_time, old.location, old.status, old.course_id)
  then
    new.revision = old.revision + 1;
  end if;
  return new;
end;
$$;

-- -------------------------------------------------------------------------
-- plan_limits - the single place a paid tier is configured.
-- Adding a tier is an INSERT here plus setting users.plan; no code change.
-- -------------------------------------------------------------------------
create table if not exists public.plan_limits (
  plan                 text primary key,
  monthly_extractions  integer not null check (monthly_extractions > 0),
  max_files_per_batch  integer not null check (max_files_per_batch > 0),
  max_file_bytes       bigint  not null check (max_file_bytes > 0),
  max_pdf_pages        integer not null check (max_pdf_pages > 0),
  extractions_per_hour integer not null check (extractions_per_hour > 0),
  max_input_chars      integer not null check (max_input_chars > 0)
);

insert into public.plan_limits
  (plan, monthly_extractions, max_files_per_batch, max_file_bytes, max_pdf_pages, extractions_per_hour, max_input_chars)
values
  ('free', 20,  10, 20 * 1024 * 1024,  60, 10, 400000),
  ('pro',  500, 25, 40 * 1024 * 1024, 300, 60, 2000000)
on conflict (plan) do nothing;

alter table public.plan_limits enable row level security;

-- -------------------------------------------------------------------------
-- users - application profile mirroring auth.users
-- -------------------------------------------------------------------------
create table if not exists public.users (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  plan        text not null default 'free' references public.plan_limits(plan),
  -- 48 hex chars of CSPRNG output. This is the bearer secret for the
  -- subscribable calendar feed, so it must be unguessable and rotatable.
  feed_token  text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.users enable row level security;

drop trigger if exists users_set_updated_at on public.users;
create trigger users_set_updated_at before update on public.users
  for each row execute function public.set_updated_at();

-- Provision a profile row whenever Supabase Auth creates an identity.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- -------------------------------------------------------------------------
-- terms
-- -------------------------------------------------------------------------
create table if not exists public.terms (
  id            uuid primary key default extensions.gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  name          text not null check (length(btrim(name)) between 1 and 120),
  -- IANA zone, used only for deadlines that state a time of day. Those are
  -- stored as wall-clock and resolved against this zone at export, so a
  -- 7:30 PM exam stays 7:30 PM across a DST boundary. Deadlines that name
  -- only a day (items.due_time IS NULL) are exported as floating all-day
  -- events and are deliberately unaffected by this.
  timezone      text not null default 'America/New_York',
  start_date    date,
  end_date      date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint terms_date_order check (end_date is null or start_date is null or end_date >= start_date)
);

alter table public.terms enable row level security;
create index if not exists terms_user_id_idx on public.terms (user_id);

drop trigger if exists terms_set_updated_at on public.terms;
create trigger terms_set_updated_at before update on public.terms
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------------------------
-- courses
-- -------------------------------------------------------------------------
create table if not exists public.courses (
  id            uuid primary key default extensions.gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  term_id       uuid not null references public.terms(id) on delete cascade,
  code          text not null check (length(btrim(code)) between 1 and 40),
  name          text,
  -- Course colour is decoration only. The course code is always rendered as
  -- text next to it so colour is never the sole carrier of meaning (WCAG 1.4.1).
  color         text not null default '#2563eb' check (color ~ '^#[0-9a-fA-F]{6}$'),
  -- 0 = Sunday .. 6 = Saturday. Used to resolve "Week 3, Thursday".
  meeting_days  smallint[] not null default '{}'::smallint[]
                  check (meeting_days <@ array[0,1,2,3,4,5,6]::smallint[]),
  position      integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.courses enable row level security;
create index if not exists courses_user_id_idx on public.courses (user_id);
create index if not exists courses_term_id_idx on public.courses (term_id);
create unique index if not exists courses_term_code_key
  on public.courses (term_id, lower(btrim(code)));

drop trigger if exists courses_set_updated_at on public.courses;
create trigger courses_set_updated_at before update on public.courses
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------------------------
-- extraction_jobs - background extraction, polled by the UI
-- -------------------------------------------------------------------------
create table if not exists public.extraction_jobs (
  id               uuid primary key default extensions.gen_random_uuid(),
  user_id          uuid not null references public.users(id) on delete cascade,
  term_id          uuid references public.terms(id) on delete set null,
  status           public.job_status not null default 'queued',
  total_files      integer not null default 0,
  processed_files  integer not null default 0,
  -- Per-file failures so a partial success can still tell the student exactly
  -- which file did not make it. [{ filename, reason }]
  file_errors      jsonb not null default '[]'::jsonb,
  error_message    text,
  item_count       integer not null default 0,
  attempts         integer not null default 0,
  -- What the student typed into "Course name" when the material does not say.
  course_hint      text,
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz
);

alter table public.extraction_jobs enable row level security;
create index if not exists extraction_jobs_user_idx on public.extraction_jobs (user_id, created_at desc);

-- -------------------------------------------------------------------------
-- uploads
-- -------------------------------------------------------------------------
create table if not exists public.uploads (
  id              uuid primary key default extensions.gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  job_id          uuid references public.extraction_jobs(id) on delete cascade,
  -- Object key in the PRIVATE `syllabi` storage bucket. Reads always go
  -- through a short-lived signed URL; the bucket has no public access.
  storage_path    text,
  filename        text not null,
  mime_type       text not null,
  size_bytes      bigint not null check (size_bytes >= 0),
  page_count      integer,
  status          public.upload_status not null default 'pending',
  error_message   text,
  -- Full document text is working state for the extractor only. It is
  -- cleared as soon as the job finishes; `items.source_snippet` is the only
  -- text retained long term.
  extracted_text  text,
  text_purged_at  timestamptz,
  -- Files and their rows are hard-deleted 30 days after processing.
  purge_after     timestamptz not null default now() + interval '30 days',
  created_at      timestamptz not null default now()
);

alter table public.uploads enable row level security;
create index if not exists uploads_user_idx on public.uploads (user_id);
create index if not exists uploads_job_idx on public.uploads (job_id);
create index if not exists uploads_purge_idx on public.uploads (purge_after);

-- -------------------------------------------------------------------------
-- items
-- -------------------------------------------------------------------------
create table if not exists public.items (
  id               uuid primary key default extensions.gen_random_uuid(),
  user_id          uuid not null references public.users(id) on delete cascade,
  term_id          uuid not null references public.terms(id) on delete cascade,
  course_id        uuid not null references public.courses(id) on delete cascade,
  title            text not null check (length(btrim(title)) between 1 and 300),
  type             public.item_type not null default 'other',
  -- Null when the extractor could not resolve a date. We never guess.
  due_date         date,
  -- Wall time in the term's zone. NULL means a day-level deadline: the
  -- syllabus gave a date and no hour, so the item exports as an all-day event
  -- rather than a timezone-dependent instant. We never invent a time.
  due_time         time,
  weight           numeric(5,2) check (weight is null or (weight >= 0 and weight <= 100)),
  location         text,
  -- Verbatim source text. Enforced non-empty: no item without a provenance.
  source_snippet   text not null check (length(btrim(source_snippet)) > 0),
  source_upload_id uuid references public.uploads(id) on delete set null,
  confidence       public.confidence_level not null default 'medium',
  status           public.item_status not null default 'active',
  -- Normalised key used to collapse the same midterm listed in two files.
  dedupe_key       text,
  -- ICS SEQUENCE. Bumped by trigger on any user-visible change.
  revision         integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.items enable row level security;
create index if not exists items_user_idx on public.items (user_id);
create index if not exists items_course_idx on public.items (course_id);
create index if not exists items_term_due_idx on public.items (term_id, due_date);
create index if not exists items_dedupe_idx on public.items (course_id, dedupe_key)
  where dedupe_key is not null;

drop trigger if exists items_bump_revision on public.items;
create trigger items_bump_revision before update on public.items
  for each row execute function public.bump_revision();

-- -------------------------------------------------------------------------
-- calendar_connections - Google Calendar OAuth
-- -------------------------------------------------------------------------
-- Tokens are AES-256-GCM ciphertext; the key lives only in the server
-- environment. On top of that, SELECT on the token columns is revoked from
-- the `anon` and `authenticated` roles in 0003_rls.sql, so even a compromised
-- anon key cannot read ciphertext out of the table.
create table if not exists public.calendar_connections (
  id                       uuid primary key default extensions.gen_random_uuid(),
  user_id                  uuid not null unique references public.users(id) on delete cascade,
  provider                 text not null default 'google' check (provider in ('google')),
  google_account_email     text,
  google_calendar_id       text,
  calendar_name            text,
  scope                    text,
  refresh_token_encrypted  text not null,
  access_token_encrypted   text,
  access_token_expires_at  timestamptz,
  last_synced_at           timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

alter table public.calendar_connections enable row level security;

drop trigger if exists calendar_connections_set_updated_at on public.calendar_connections;
create trigger calendar_connections_set_updated_at before update on public.calendar_connections
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------------------------
-- usage_events - unit economics from day one
-- -------------------------------------------------------------------------
create table if not exists public.usage_events (
  id                  bigint generated always as identity primary key,
  user_id             uuid references public.users(id) on delete set null,
  job_id              uuid references public.extraction_jobs(id) on delete set null,
  kind                text not null check (kind in ('extraction','demo_extraction','export_ics','gcal_sync')),
  model               text,
  input_tokens        integer not null default 0,
  output_tokens       integer not null default 0,
  cache_read_tokens   integer not null default 0,
  cache_write_tokens  integer not null default 0,
  cost_usd            numeric(12,6) not null default 0,
  files_count         integer not null default 0,
  chunks_count        integer not null default 0,
  duration_ms         integer,
  succeeded           boolean not null default true,
  created_at          timestamptz not null default now()
);

alter table public.usage_events enable row level security;
create index if not exists usage_events_user_month_idx
  on public.usage_events (user_id, created_at desc);

-- -------------------------------------------------------------------------
-- rate_limits - fixed-window counters, enforced in the database so that
-- concurrent serverless invocations cannot race past the limit.
-- -------------------------------------------------------------------------
create table if not exists public.rate_limits (
  bucket        text        not null,
  window_start  timestamptz not null,
  count         integer     not null default 0,
  primary key (bucket, window_start)
);

alter table public.rate_limits enable row level security;
create index if not exists rate_limits_window_idx on public.rate_limits (window_start);
