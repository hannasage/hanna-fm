import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const REQUEST_TIMEOUT_MS = 3_000;

/**
 * The only door to the database. Server code only.
 * The service role key never reaches the browser: no variable here starts
 * with NEXT_PUBLIC_, and `server-only` fails the build if a client component
 * imports this file.
 */
export function createServerSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set on the server.");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
    },
  });
}
