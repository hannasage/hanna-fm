import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;

/** The server is missing a setting it needs. The code is safe to log. */
export class ServerConfigError extends Error {
  readonly code = "SERVER_ENV_MISSING";

  constructor() {
    super("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set on the server.");
    this.name = "ServerConfigError";
  }
}

/**
 * The only door to the database. Server code only.
 * The service role key never reaches the browser: no variable here starts
 * with NEXT_PUBLIC_, and `server-only` fails the build if a client component
 * imports this file.
 *
 * Every request stops at the timeout, or sooner when the caller's own signal aborts.
 */
export function createServerSupabase(
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new ServerConfigError();
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        const signals = [AbortSignal.timeout(timeoutMs)];
        if (init?.signal) signals.push(init.signal);
        return fetch(input, { ...init, signal: AbortSignal.any(signals) });
      },
    },
  });
}
