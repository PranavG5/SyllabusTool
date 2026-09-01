-- =========================================================================
-- Create the private storage bucket, and FAIL if it does not get created
-- =========================================================================
-- 0004 wrapped this in `if to_regclass('storage.buckets') is null then return`
-- so the local RLS harness (which has no storage schema) could run the same
-- migration set. On the production project that guard silently skipped
-- everything: `to_regclass` also returns NULL when the object exists but the
-- role running the migration cannot see the schema, and the migration reported
-- success with zero buckets created. The first upload then failed with a
-- generic "we could not save your upload".
--
-- Two changes here:
--   * detect a real Supabase with pg_namespace, which every role can read,
--     rather than to_regclass, which depends on schema USAGE;
--   * assert at the end, so a failure is loud instead of a silent no-op.
-- =========================================================================

do $$
declare
  v_on_supabase boolean;
begin
  -- pg_namespace is world-readable, so this cannot produce a false negative
  -- the way a privilege-dependent lookup can.
  select exists (select 1 from pg_namespace where nspname = 'storage')
    into v_on_supabase;

  if not v_on_supabase then
    raise notice 'no storage schema (local test harness); skipping bucket setup';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'syllabi', 'syllabi', false, 41943040,
    array[
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'text/plain',
      'text/markdown',
      'image/png',
      'image/jpeg',
      'image/webp'
    ]
  )
  on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  -- Objects are keyed `<user_id>/<batch_id>/<file>`, so the first path segment
  -- is the tenant boundary. Uploads normally arrive on a signed URL, which is
  -- pre-authorised; these policies are the second layer for any direct client
  -- access.
  execute 'drop policy if exists syllabi_read_own on storage.objects';
  execute 'create policy syllabi_read_own on storage.objects
      for select to authenticated
      using (bucket_id = ''syllabi'' and (storage.foldername(name))[1] = (select auth.uid())::text)';

  execute 'drop policy if exists syllabi_insert_own on storage.objects';
  execute 'create policy syllabi_insert_own on storage.objects
      for insert to authenticated
      with check (bucket_id = ''syllabi'' and (storage.foldername(name))[1] = (select auth.uid())::text)';

  execute 'drop policy if exists syllabi_delete_own on storage.objects';
  execute 'create policy syllabi_delete_own on storage.objects
      for delete to authenticated
      using (bucket_id = ''syllabi'' and (storage.foldername(name))[1] = (select auth.uid())::text)';

  -- The whole point of this migration. A silent skip is what broke production.
  if not exists (select 1 from storage.buckets where id = 'syllabi') then
    raise exception 'syllabi bucket was not created — uploads would fail at runtime';
  end if;

  raise notice 'syllabi bucket present and policies applied';
end $$;
