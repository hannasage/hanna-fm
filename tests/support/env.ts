import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Values the global setup puts in the environment for the test workers.
 * They live in memory only. No test writes them to disk or prints them.
 */
export type SiteName = "healthy" | "refused" | "hanging" | "badKey" | "missingEnv" | "malformed" | "inProgress";

export type TestEnv = {
  apiUrl: string;
  dbUrl: string;
  anonKey: string;
  publishableKey: string | undefined;
  serviceRoleKey: string;
  /** Every secret-looking value the Supabase CLI reported, by variable name. */
  secrets: { name: string; value: string }[];
  logDir: string;
  sites: Record<SiteName, string>;
};

function need(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Is global setup running?`);
  }
  return value;
}

export function testEnv(): TestEnv {
  return {
    apiUrl: need("TEST_API_URL"),
    dbUrl: need("TEST_DB_URL"),
    anonKey: need("TEST_ANON_KEY"),
    publishableKey: process.env.TEST_PUBLISHABLE_KEY || undefined,
    serviceRoleKey: need("TEST_SERVICE_ROLE_KEY"),
    secrets: JSON.parse(need("TEST_SECRETS")) as { name: string; value: string }[],
    logDir: need("TEST_LOG_DIR"),
    sites: {
      healthy: need("TEST_SITE_HEALTHY_URL"),
      refused: need("TEST_SITE_REFUSED_URL"),
      hanging: need("TEST_SITE_HANGING_URL"),
      badKey: need("TEST_SITE_BADKEY_URL"),
      missingEnv: need("TEST_SITE_MISSINGENV_URL"),
      malformed: need("TEST_SITE_MALFORMED_URL"),
      inProgress: need("TEST_SITE_INPROGRESS_URL"),
    },
  };
}

/** What one copy of the site wrote to stdout and stderr so far. */
export function readSiteLog(name: SiteName): string {
  try {
    return readFileSync(join(testEnv().logDir, `${name}.log`), "utf8");
  } catch {
    return "";
  }
}

/** Waits until the site's log holds the text, or the time runs out. Returns the log. */
export async function waitForSiteLog(
  name: SiteName,
  text: string,
  timeoutMs = 5_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const log = readSiteLog(name);
    if (log.includes(text) || Date.now() >= deadline) return log;
    await new Promise((r) => setTimeout(r, 100));
  }
}
