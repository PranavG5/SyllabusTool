import 'server-only';

/**
 * Supabase clients for server code.
 *
 * `createServerClient` runs as the signed-in user, so every query it makes is
 * still filtered by RLS — the browser's session is carried through, not
 * bypassed. `createAdminClient` uses the service role and bypasses RLS, so it
 * is confined to the few operations that legitimately need it (writing
 * extraction results, reading OAuth tokens, purging accounts) and every one
 * of those scopes its own queries by user id.
 */

import { createServerClient as createSSRClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import type { Database } from './types';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function supabaseUrl(): string {
  return requireEnv('NEXT_PUBLIC_SUPABASE_URL');
}

export async function createServerClient(): Promise<SupabaseClient<Database>> {
  const cookieStore = await cookies();
  return createSSRClient<Database>(
    supabaseUrl(),
    requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) => {
          try {
            for (const { name, value, options } of toSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // Middleware refreshes the session, so this is safe to ignore.
          }
        },
      },
    },
  );
}

let admin: SupabaseClient<Database> | null = null;

/** Service role. Bypasses RLS — scope every query by user id yourself. */
export function createAdminClient(): SupabaseClient<Database> {
  if (admin) return admin;
  admin = createClient<Database>(supabaseUrl(), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return admin;
}

export interface AuthedUser {
  id: string;
  email: string | null;
}

/** The signed-in user, or null. Never throws. */
export async function getCurrentUser(): Promise<AuthedUser | null> {
  const supabase = await createServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}
