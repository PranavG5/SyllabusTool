-- =========================================================================
-- Syllabus Tool - security-definer functions
-- =========================================================================
-- Quota, rate limiting and retention are enforced here rather than in
-- application code so that concurrent serverless invocations cannot race
-- past a limit and so a bug in one route cannot bypass them.
-- =========================================================================

-- -------------------------------------------------------------------------
-- consume_rate_limit: atomic fixed-window counter.
-- Returns true when the caller is under the limit (the increment always
-- happens, so a rejected caller still counts against the window).
-- -------------------------------------------------------------------------
create or replace function public.consume_rate_limit(
  p_bucket         text,
  p_limit          integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz;
  v_count  integer;
begin
  if p_limit <= 0 or p_window_seconds <= 0 then
    raise exception 'consume_rate_limit: limit and window must be positive';
  end if;

  v_window := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );

  insert into public.rate_limits as rl (bucket, window_start, count)
  values (p_bucket, v_window, 1)
  on conflict (bucket, window_start)
    do update set count = rl.count + 1
  returning rl.count into v_count;

  return v_count <= p_limit;
end;
$$;

-- -------------------------------------------------------------------------
-- consume_extraction_quota: THE quota gate.
--
-- Every extraction path (authenticated upload, paste, retry) goes through
-- this one function. Introducing a paid tier means inserting a row into
-- plan_limits and setting users.plan - no change here and none in app code.
--
-- Returns jsonb: { allowed, reason?, plan, used, limit, ...plan limits }
-- -------------------------------------------------------------------------
create or replace function public.consume_extraction_quota(
  p_user_id uuid,
  p_files   integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan        text;
  v_limits      public.plan_limits;
  v_month_start timestamptz;
  v_used        integer;
  v_within_rate boolean;
  v_limit_json  jsonb;
begin
  -- Serialise quota decisions per user. Without this, two concurrent
  -- requests can both read used = limit - 1 and both be admitted.
  perform pg_advisory_xact_lock(hashtextextended('quota:' || p_user_id::text, 0));

  select u.plan into v_plan from public.users u where u.id = p_user_id;
  if v_plan is null then
    return jsonb_build_object('allowed', false, 'reason', 'no_account');
  end if;

  select * into v_limits from public.plan_limits pl where pl.plan = v_plan;
  if v_limits.plan is null then
    return jsonb_build_object('allowed', false, 'reason', 'unknown_plan');
  end if;

  v_limit_json := jsonb_build_object(
    'plan',                v_limits.plan,
    'monthlyExtractions',  v_limits.monthly_extractions,
    'maxFilesPerBatch',    v_limits.max_files_per_batch,
    'maxFileBytes',        v_limits.max_file_bytes,
    'maxPdfPages',         v_limits.max_pdf_pages,
    'extractionsPerHour',  v_limits.extractions_per_hour,
    'maxInputChars',       v_limits.max_input_chars
  );

  if p_files > v_limits.max_files_per_batch then
    return jsonb_build_object('allowed', false, 'reason', 'too_many_files',
                              'limit', v_limits.max_files_per_batch, 'limits', v_limit_json);
  end if;

  -- Jobs that failed outright do not consume monthly quota: a student should
  -- not be charged for our extraction falling over.
  v_month_start := date_trunc('month', now());
  select count(*) into v_used
    from public.extraction_jobs j
   where j.user_id = p_user_id
     and j.created_at >= v_month_start
     and j.status <> 'failed';

  if v_used >= v_limits.monthly_extractions then
    return jsonb_build_object('allowed', false, 'reason', 'monthly_quota_exceeded',
                              'used', v_used, 'limit', v_limits.monthly_extractions,
                              'limits', v_limit_json);
  end if;

  v_within_rate := public.consume_rate_limit(
    'extract:user:' || p_user_id::text, v_limits.extractions_per_hour, 3600
  );
  if not v_within_rate then
    return jsonb_build_object('allowed', false, 'reason', 'rate_limited',
                              'limit', v_limits.extractions_per_hour, 'limits', v_limit_json);
  end if;

  return jsonb_build_object('allowed', true, 'plan', v_plan,
                            'used', v_used, 'limit', v_limits.monthly_extractions,
                            'limits', v_limit_json);
end;
$$;

-- -------------------------------------------------------------------------
-- get_quota_status: read-only view of the same numbers, for the UI.
-- -------------------------------------------------------------------------
create or replace function public.get_quota_status(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan   text;
  v_limits public.plan_limits;
  v_used   integer;
begin
  select u.plan into v_plan from public.users u where u.id = p_user_id;
  if v_plan is null then
    return jsonb_build_object('plan', null, 'used', 0, 'limit', 0);
  end if;

  select * into v_limits from public.plan_limits pl where pl.plan = v_plan;

  select count(*) into v_used
    from public.extraction_jobs j
   where j.user_id = p_user_id
     and j.created_at >= date_trunc('month', now())
     and j.status <> 'failed';

  return jsonb_build_object(
    'plan', v_plan,
    'used', v_used,
    'limit', v_limits.monthly_extractions,
    'remaining', greatest(v_limits.monthly_extractions - v_used, 0),
    'maxFilesPerBatch', v_limits.max_files_per_batch,
    'maxFileBytes', v_limits.max_file_bytes,
    'maxPdfPages', v_limits.max_pdf_pages,
    'maxInputChars', v_limits.max_input_chars
  );
end;
$$;

-- -------------------------------------------------------------------------
-- Retention
-- -------------------------------------------------------------------------

-- Clear working document text once a job is done. `items.source_snippet` is
-- the only extracted text kept beyond this point.
create or replace function public.purge_job_text(p_job_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_count integer;
begin
  update public.uploads
     set extracted_text = null,
         text_purged_at = now()
   where job_id = p_job_id
     and extracted_text is not null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Step 1 of the 30-day file purge: report what is due. The caller deletes the
-- objects from the private bucket, then calls delete_purged_uploads() with the
-- ids it actually removed, so a storage failure never orphans a blob.
create or replace function public.list_expired_uploads(p_limit integer default 500)
returns table (id uuid, user_id uuid, storage_path text)
language sql
security definer
set search_path = ''
as $$
  select u.id, u.user_id, u.storage_path
    from public.uploads u
   where u.purge_after <= now()
   order by u.purge_after
   limit least(greatest(p_limit, 1), 5000);
$$;

create or replace function public.delete_purged_uploads(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_count integer;
begin
  delete from public.uploads where id = any(p_ids);
  get diagnostics v_count = row_count;

  -- Opportunistic housekeeping: rate-limit windows are worthless once closed.
  delete from public.rate_limits where window_start < now() - interval '2 days';

  return v_count;
end;
$$;

-- -------------------------------------------------------------------------
-- purge_user_data: account deletion that actually deletes.
-- Returns the storage paths the caller must remove from the private bucket.
-- The caller then deletes the auth.users row.
-- -------------------------------------------------------------------------
create or replace function public.purge_user_data(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_paths text[];
begin
  select coalesce(array_agg(u.storage_path), '{}'::text[])
    into v_paths
    from public.uploads u
   where u.user_id = p_user_id
     and u.storage_path is not null;

  -- Explicit rather than relying on cascades, so the delete order is
  -- auditable and OAuth tokens are provably gone.
  delete from public.calendar_connections where user_id = p_user_id;
  delete from public.items                where user_id = p_user_id;
  delete from public.uploads              where user_id = p_user_id;
  delete from public.extraction_jobs      where user_id = p_user_id;
  delete from public.courses              where user_id = p_user_id;
  delete from public.terms                where user_id = p_user_id;
  delete from public.usage_events         where user_id = p_user_id;
  delete from public.users                where id      = p_user_id;

  return jsonb_build_object('storage_paths', to_jsonb(v_paths));
end;
$$;

-- -------------------------------------------------------------------------
-- rotate_feed_token: lets a student invalidate a leaked calendar feed URL.
-- SECURITY DEFINER because feed_token is not writable by the `authenticated`
-- role (see the column grants in 0003_rls.sql), but it is self-scoped: the
-- WHERE clause is auth.uid(), so it can only ever rotate the caller's token.
-- -------------------------------------------------------------------------
create or replace function public.rotate_feed_token()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare v_token text;
begin
  update public.users
     set feed_token = encode(extensions.gen_random_bytes(24), 'hex')
   where id = auth.uid()
  returning feed_token into v_token;

  if v_token is null then
    raise exception 'not authenticated';
  end if;
  return v_token;
end;
$$;
