import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SeedRefusedError, assertLocalUrl, easternDate, generateFakePlays } from "./fake-plays.ts";

/**
 * Fills the LOCAL Supabase stack with fake plays. Run it with `npm run db:seed-fake`.
 *
 * It refuses any address that is not 127.0.0.1 or localhost, and checks that before it reads a key
 * or opens a connection. With no SUPABASE_URL it asks the local Supabase CLI, which only ever
 * reports the local stack. Keys stay in memory and are never printed.
 *
 * A run replaces the fake plays: it deletes the plays whose track address is a fake one, then inserts
 * a fresh set. Any rerun, on any day, leaves exactly one set. Other plays are never touched.
 */

const BATCH = 500;

/** Matches only the addresses this seed makes: "spotify:track:fake" and four more characters. A real address is 22 long. */
const FAKE_URI_FILTER = "like.spotify:track:fake____";

/** The settings the seed reads. A plain object works, so a test need not build a full process environment. */
export type Env = Record<string, string | undefined>;

type Target = { origin: string; serviceKey: string };

/** A request to the database failed. `done` says how many fake plays were stored before it did. */
export class SeedRequestError extends Error {
  readonly done: number;
  constructor(message: string, done: number) {
    super(`${message} Stored before the failure: ${done}. Run the command again to start clean.`);
    this.name = "SeedRequestError";
    this.done = done;
  }
}

/** The values `supabase status -o env` reports, read as text. */
function runStatus(): string {
  try {
    return execFileSync("supabase", ["status", "-o", "env"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("The Supabase CLI was not found. Install it, then run this again.");
    }
    const status = (error as { status?: number | null }).status;
    throw new Error(
      `Local Supabase did not answer (\`supabase status\` exited with ${status ?? "no code"}). Start it with \`npm run db:start\`, then run this again.`,
    );
  }
}

function parseStatus(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const match = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) values[match[1]] = match[2];
  }
  return values;
}

/**
 * Picks the target and refuses it unless it is local. The address is checked first. The key is read only after
 * the check passes, so a refused address never touches a key. Every later request is built from the checked
 * address's origin, never from the text that was given.
 */
export function resolveTarget(env: Env, readStatus: () => string = runStatus): Target {
  if (env.SUPABASE_URL) {
    const url = assertLocalUrl(env.SUPABASE_URL);
    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceKey) throw new SeedRefusedError("SUPABASE_URL is set but SUPABASE_SERVICE_ROLE_KEY is not.");
    return { origin: url.origin, serviceKey };
  }
  const values = parseStatus(readStatus());
  if (!values.API_URL) throw new Error("The Supabase CLI did not report the local address.");
  const url = assertLocalUrl(values.API_URL);
  const serviceKey = values.SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("The Supabase CLI did not report the local key.");
  return { origin: url.origin, serviceKey };
}

/**
 * One request to the plays table. A redirect is an error: the key travels in a header, and a process that
 * is not the database must not be able to send it on to another host.
 */
async function request(target: Target, method: "POST" | "DELETE", query: string, prefer: string, body: string | undefined, done: number) {
  let response: Response;
  try {
    response = await fetch(`${target.origin}/rest/v1/plays?${query}`, {
      method,
      redirect: "error",
      headers: {
        apikey: target.serviceKey,
        Authorization: `Bearer ${target.serviceKey}`,
        "Content-Type": "application/json",
        Prefer: prefer,
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const why = cause?.code ?? cause?.message ?? (error as Error).name;
    throw new SeedRequestError(`The request to the database failed (${why}).`, done);
  }
  if (!response.ok) {
    throw new SeedRequestError(`The database refused a request (HTTP ${response.status}).`, done);
  }
  return response;
}

async function deleteFakePlays(target: Target): Promise<number> {
  const response = await request(target, "DELETE", `track_uri=${FAKE_URI_FILTER}&select=id`, "return=representation", undefined, 0);
  const removed = (await response.json()) as unknown;
  if (!Array.isArray(removed)) throw new SeedRequestError("The database answered with a shape the seed does not know.", 0);
  return removed.length;
}

async function insertBatch(target: Target, rows: unknown[], done: number): Promise<number> {
  const response = await request(
    target,
    "POST",
    "on_conflict=track_uri,ended_at&select=id",
    "resolution=ignore-duplicates,return=representation",
    JSON.stringify(rows),
    done,
  );
  const stored = (await response.json()) as unknown;
  if (!Array.isArray(stored)) throw new SeedRequestError("The database answered with a shape the seed does not know.", done);
  return stored.length;
}

export async function seedFakePlays(
  env: Env,
  now: Date = new Date(),
  readStatus?: () => string,
): Promise<{ removed: number; inserted: number }> {
  const target = resolveTarget(env, readStatus);
  const plays = generateFakePlays({ today: easternDate(now) });
  const removed = await deleteFakePlays(target);
  let inserted = 0;
  for (let i = 0; i < plays.length; i += BATCH) {
    inserted += await insertBatch(target, plays.slice(i, i + BATCH), inserted);
  }
  return { removed, inserted };
}

/**
 * True when this file is the one node was asked to run, even through a symlink.
 * A test sets VITEST and SEED_NOW to pin the clock. A person's own SEED_NOW is ignored.
 */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function clock(env: Env): Date {
  if (env.VITEST && env.SEED_NOW) {
    const pinned = new Date(env.SEED_NOW);
    if (Number.isNaN(pinned.getTime())) throw new Error("SEED_NOW is not a date.");
    return pinned;
  }
  return new Date();
}

if (isMain()) {
  Promise.resolve()
    .then(() => seedFakePlays(process.env, clock(process.env)))
    .then(
    ({ removed, inserted }) => {
      console.log(`Fake plays: removed ${removed}, inserted ${inserted}.`);
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : "The seed failed.");
      process.exitCode = 1;
    },
  );
}
