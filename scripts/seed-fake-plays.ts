import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { SeedRefusedError, assertLocalUrl, easternDate, generateFakePlays } from "./fake-plays.ts";

/**
 * Fills the LOCAL Supabase stack with fake plays. Run it with `npm run db:seed-fake`.
 *
 * It refuses any address that is not 127.0.0.1 or localhost, and checks that before it reads a key
 * or opens a connection. With no SUPABASE_URL it asks the local Supabase CLI, which only ever
 * reports the local stack. Keys stay in memory and are never printed.
 *
 * Safe to run again: a play already stored (same track and time) is skipped, not doubled.
 */

const BATCH = 500;

type Target = { apiUrl: string; serviceKey: string };

function readLocalStack(): Target {
  let output: string;
  try {
    output = execFileSync("supabase", ["status", "-o", "env"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error("Local Supabase is not running. Start it with `npm run db:start`, then run this again.");
  }
  const values: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const match = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) values[match[1]] = match[2];
  }
  if (!values.API_URL || !values.SERVICE_ROLE_KEY) {
    throw new Error("The Supabase CLI did not report the local address and key.");
  }
  return { apiUrl: values.API_URL, serviceKey: values.SERVICE_ROLE_KEY };
}

/** Picks the target and refuses it unless it is local. The key is read only after the address passes. */
export function resolveTarget(env: NodeJS.ProcessEnv): Target {
  const given = env.SUPABASE_URL;
  const target: Target = given
    ? (() => {
        assertLocalUrl(given);
        if (!env.SUPABASE_SERVICE_ROLE_KEY) {
          throw new SeedRefusedError("SUPABASE_URL is set but SUPABASE_SERVICE_ROLE_KEY is not.");
        }
        return { apiUrl: given, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY };
      })()
    : readLocalStack();
  assertLocalUrl(target.apiUrl);
  return target;
}

async function insertBatch(target: Target, rows: unknown[]): Promise<number> {
  const response = await fetch(`${target.apiUrl}/rest/v1/plays?on_conflict=track_uri,ended_at&select=id`, {
    method: "POST",
    headers: {
      apikey: target.serviceKey,
      Authorization: `Bearer ${target.serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=representation",
    },
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`The database refused a batch of plays (HTTP ${response.status}).`);
  }
  const stored = (await response.json()) as unknown;
  if (!Array.isArray(stored)) throw new Error("The database answered with a shape the seed does not know.");
  return stored.length;
}

export async function seedFakePlays(env: NodeJS.ProcessEnv, now: Date = new Date()): Promise<{ inserted: number; skipped: number }> {
  const target = resolveTarget(env);
  const plays = generateFakePlays({ today: easternDate(now) });
  let inserted = 0;
  for (let i = 0; i < plays.length; i += BATCH) {
    inserted += await insertBatch(target, plays.slice(i, i + BATCH));
  }
  return { inserted, skipped: plays.length - inserted };
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  seedFakePlays(process.env).then(
    ({ inserted, skipped }) => {
      console.log(`Fake plays: inserted ${inserted}, skipped ${skipped} already stored.`);
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : "The seed failed.");
      process.exitCode = 1;
    },
  );
}
