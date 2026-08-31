-- =========================================================================
-- Lock down every SECURITY DEFINER function
-- =========================================================================
-- Found by Supabase's security advisor against the deployed database.
--
-- 0003 does `revoke all on all functions ... from anon, authenticated`, which
-- looks sufficient but is not: PostgreSQL grants EXECUTE on new functions to
-- the pseudo-role PUBLIC, and `anon`/`authenticated` inherit that grant. A
-- revoke naming only those two roles leaves the inherited PUBLIC grant intact.
--
-- 0003 already revoked from `public` explicitly for seven functions.
-- handle_new_auth_user was created in 0001 and missed, so it stayed callable
-- as `/rest/v1/rpc/handle_new_auth_user`. It is a trigger function and would
-- error on a direct call, but a SECURITY DEFINER function has no business
-- being reachable from a browser regardless.
-- =========================================================================

revoke all on function public.handle_new_auth_user() from public, anon, authenticated;

-- Belt and braces: revoke the inherited PUBLIC grant on every function in the
-- schema, then grant back only the one that is meant to be callable.
revoke all on all functions in schema public from public, anon, authenticated;

-- rotate_feed_token is the single deliberate exception. It takes no arguments
-- and its WHERE clause is auth.uid(), so it can only ever rotate the caller's
-- own feed token. The advisor will keep flagging it; that is expected.
grant execute on function public.rotate_feed_token() to authenticated;

-- The server calls the rest through the service role, which Supabase grants
-- separately; re-assert it so the blanket revoke above cannot strand the app.
grant execute on all functions in schema public to service_role;

-- New functions must not inherit a PUBLIC execute grant either.
alter default privileges in schema public revoke all on functions from public, anon, authenticated;
