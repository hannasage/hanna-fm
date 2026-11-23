import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastLines, redactLines } from "./redact";
import type { SiteName } from "./env";

/**
 * Reads the local Supabase stack, builds the site once, then starts five copies
 * with `next start`. The environment is read at run time, so one build serves all:
 *  - healthy: points at the real local database
 *  - refused: points at a port where nothing listens
 *  - hanging: points at a port that accepts a connection and never answers
 *  - badKey: points at the real database with a key it rejects (PostgREST 401)
 *  - missingEnv: has no database variables at all
 *
 * Keys are read from the Supabase CLI and kept in process memory.
 * They are never written to a file or printed. Each site's stdout and stderr go
 * to a file in a temporary folder, which the tests read and teardown removes.
 */

type Site = {
  name: SiteName;
  pid: number;
  exited: Promise<void>;
  hasExited: () => boolean;
  exitCode: () => number | null;
};

const sites: Site[] = [];
const servers: Server[] = [];
let logDir = "";
let knownSecrets: string[] = [];

function readSupabaseEnv(): Record<string, string> {
  let output: string;
  try {
    output = execFileSync("supabase", ["status", "-o", "env"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    const reason = redactLines(stderr).trim() || (error as Error).message.split("\n")[0];
    throw new Error(
      `Local Supabase is not running or did not answer. Start it with \`npm run db:start\`, then run the tests again. The CLI said: ${reason}`,
    );
  }
  const values: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const match = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) values[match[1]] = match[2];
  }
  return values;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function hangingDatabase(): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("error", reject);
    server.on("close", () => sockets.forEach((s) => s.destroy()));
    server.listen(0, "127.0.0.1", () => {
      servers.push(server);
      const address = server.address();
      resolve({ port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

function tail(file: string): string {
  try {
    return lastLines(redactLines(readFileSync(file, "utf8"), knownSecrets), 50);
  } catch {
    return "(no output)";
  }
}

/** Starts a command in its own process group, with stdout and stderr in a file. */
function launch(name: SiteName | "build", args: string[], env: NodeJS.ProcessEnv): Site {
  const logFile = join(logDir, `${name}.log`);
  const fd = openSync(logFile, "a");
  const child = spawn("node_modules/.bin/next", args, {
    cwd: process.cwd(),
    env,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  let done = false;
  let code: number | null = null;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (exitCode) => {
      done = true;
      code = exitCode;
      resolve();
    });
    child.once("error", () => {
      done = true;
      code = -1;
      resolve();
    });
  });
  return {
    name: name as SiteName,
    pid: child.pid ?? 0,
    exited,
    hasExited: () => done,
    exitCode: () => code,
  };
}

function signalGroup(site: Site, signal: NodeJS.Signals) {
  if (!site.pid) return;
  try {
    process.kill(-site.pid, signal);
  } catch {
    // The group is already gone.
  }
}

async function stopSite(site: Site) {
  signalGroup(site, "SIGTERM");
  const timedOut = await Promise.race([
    site.exited.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), 5_000)),
  ]);
  if (timedOut) {
    signalGroup(site, "SIGKILL");
    await site.exited;
  }
}

async function stopAll() {
  await Promise.all(sites.map(stopSite));
  sites.length = 0;
  for (const server of servers) server.close();
  servers.length = 0;
  if (logDir) rmSync(logDir, { recursive: true, force: true });
}

// Last resort if the runner dies before teardown: never leave a server running.
process.on("exit", () => {
  for (const site of sites) signalGroup(site, "SIGKILL");
});

async function buildOnce(env: NodeJS.ProcessEnv) {
  const build = launch("build", ["build"], env);
  await build.exited;
  if (build.exitCode() !== 0) {
    throw new Error(`The site build failed. Last 50 lines:\n${tail(join(logDir, "build.log"))}`);
  }
}

async function startSite(
  name: SiteName,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const port = await freePort();
  const site = launch(name, ["start", "-p", String(port), "-H", "127.0.0.1"], env);
  sites.push(site);

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (site.hasExited()) {
      throw new Error(
        `The ${name} site exited early. Last 50 lines:\n${tail(join(logDir, `${name}.log`))}`,
      );
    }
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(10_000) });
      if (res.status === 200 || res.status === 503) {
        const body: unknown = await res.json().catch(() => null);
        if (body && typeof body === "object" && "status" in body) return url;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `The ${name} site was not ready in time. Last 50 lines:\n${tail(join(logDir, `${name}.log`))}`,
  );
}

export default async function setup() {
  logDir = mkdtempSync(join(tmpdir(), "hanna-fm-tests-"));
  try {
    return await start();
  } catch (error) {
    await stopAll();
    throw error;
  }
}

async function start() {
  const supa = readSupabaseEnv();
  const apiUrl = supa.API_URL;
  const dbUrl = supa.DB_URL;
  const anonKey = supa.ANON_KEY;
  const serviceKey = supa.SERVICE_ROLE_KEY;
  if (!apiUrl || !dbUrl || !anonKey || !serviceKey) {
    throw new Error("The Supabase CLI did not report the values the tests need.");
  }

  const secrets = Object.entries(supa)
    .filter(([name, value]) => /KEY|SECRET|TOKEN|_URL$/.test(name) && value.length >= 8)
    .map(([name, value]) => ({ name, value }));
  knownSecrets = secrets.map((s) => s.value);

  const siteEnv = (overrides: Record<string, string | undefined>): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      SUPABASE_URL: undefined,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
      ...overrides,
    };
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    return env;
  };

  // The build sees the real values, so a leak into the browser bundle would show up in the tests.
  await buildOnce(siteEnv({ SUPABASE_URL: apiUrl, SUPABASE_SERVICE_ROLE_KEY: serviceKey }));

  const deadPort = await freePort();
  const hanging = await hangingDatabase();

  const [healthy, refused, hang, badKey, missingEnv] = await Promise.all([
    startSite("healthy", siteEnv({ SUPABASE_URL: apiUrl, SUPABASE_SERVICE_ROLE_KEY: serviceKey })),
    startSite(
      "refused",
      siteEnv({ SUPABASE_URL: `http://127.0.0.1:${deadPort}`, SUPABASE_SERVICE_ROLE_KEY: serviceKey }),
    ),
    startSite(
      "hanging",
      siteEnv({ SUPABASE_URL: `http://127.0.0.1:${hanging.port}`, SUPABASE_SERVICE_ROLE_KEY: serviceKey }),
    ),
    startSite("badKey", siteEnv({ SUPABASE_URL: apiUrl, SUPABASE_SERVICE_ROLE_KEY: "not-a-real-key" })),
    startSite("missingEnv", siteEnv({})),
  ]);

  process.env.TEST_API_URL = apiUrl;
  process.env.TEST_DB_URL = dbUrl;
  process.env.TEST_ANON_KEY = anonKey;
  process.env.TEST_PUBLISHABLE_KEY = supa.PUBLISHABLE_KEY ?? "";
  process.env.TEST_SERVICE_ROLE_KEY = serviceKey;
  process.env.TEST_SECRETS = JSON.stringify(secrets);
  process.env.TEST_LOG_DIR = logDir;
  process.env.TEST_SITE_HEALTHY_URL = healthy;
  process.env.TEST_SITE_REFUSED_URL = refused;
  process.env.TEST_SITE_HANGING_URL = hang;
  process.env.TEST_SITE_BADKEY_URL = badKey;
  process.env.TEST_SITE_MISSINGENV_URL = missingEnv;

  return stopAll;
}
