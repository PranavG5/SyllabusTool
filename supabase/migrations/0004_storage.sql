-- =========================================================================
-- Syllabus Tool - private storage bucket
-- =========================================================================
-- Runs only against a real Supabase instance (the local RLS test harness has
-- no `storage` schema, so the whole file no-ops there).
-- =========================================================================

do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema not present; skipping bucket setup';
    return;
  end if;

  -- public = false: objects are reachable only through short-lived signed
  -- URLs minted server-side. There is no unauthenticated object URL.
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

  -- Objects are keyed `<user_id>/<job_id>/<filename>`, so the first path
  -- segment is the tenant boundary.
  execute $p$ drop policy if exists syllabi_read_own on storage.objects $p$;
  execute $p$
    create policy syllabi_read_own on storage.objects
      for select to authenticated
      using (bucket_id = 'syllabi' and (storage.foldername(name))[1] = (select auth.uid())::text)
  $p$;

  execute $p$ drop policy if exists syllabi_insert_own on storage.objects $p$;
  execute $p$
    create policy syllabi_insert_own on storage.objects
      for insert to authenticated
      with check (bucket_id = 'syllabi' and (storage.foldername(name))[1] = (select auth.uid())::text)
  $p$;

  execute $p$ drop policy if exists syllabi_delete_own on storage.objects $p$;
  execute $p$
    create policy syllabi_delete_own on storage.objects
      for delete to authenticated
      using (bucket_id = 'syllabi' and (storage.foldername(name))[1] = (select auth.uid())::text)
  $p$;
end $$;
