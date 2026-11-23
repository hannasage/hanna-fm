import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
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
 *  - malformed: points at a stub that answers the chart functions and the poller tables with a bad shape
 *  - inProgress: points at a stub that answers the chart functions with fixed weeks, so the Charts page can be
 *    tested on a day when the running week has a chart. The real database reads its own clock, and no play
 *    counts for the running week before Wednesday.
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

/**
 * A stub of the two chart functions that answers with data the real database never sends.
 * The kind in the request picks the fault, so one stub serves every case:
 *  - track: a chart row whose rank is text
 *  - artist: bounds with no latest_week column
 *  - album: bounds whose latest_week is not a date
 *  - any kind with limit 2: a chart that is an object, not a list
 */
function stubDatabase(): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    const server = createHttpServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        let args: { p_kind?: string; p_limit?: number } = {};
        try {
          args = JSON.parse(body || "{}") as typeof args;
        } catch {
          // A body that is not JSON gets the empty arguments.
        }
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        const bounds = { first_week: "2026-02-02", latest_week: "2026-02-16", current_week: "2026-11-23" };
        if (req.url?.includes("/rpc/chart_bounds")) {
          if (args.p_kind === "artist") {
            return send(200, [{ first_week: bounds.first_week, current_week: bounds.current_week }]);
          }
          if (args.p_kind === "album") return send(200, [{ ...bounds, latest_week: "soon" }]);
          return send(200, [bounds]);
        }
        if (req.url?.includes("/rpc/chart_weekly")) {
          if (args.p_limit === 2) return send(200, { rows: [] });
          return send(200, [
            { rank: "one", key: "k", name: "n", plays: 1, minutes: 1, last_week_rank: null, peak_rank: 1, weeks_on_chart: 1 },
          ]);
        }
        // The status route reads these two tables. The run has a finish time that is not a date.
        if (req.url?.includes("/rest/v1/poller_runs")) {
          return send(200, [{ outcome: "ok", finished_at: "not-a-date", failure_kind: null }]);
        }
        if (req.url?.includes("/rest/v1/poller_state")) return send(200, []);
        return send(404, { message: "not found" });
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      servers.push(server);
      const address = server.address();
      resolve({ port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

/**
 * A stand-in for the two chart functions with a fixed idea of which week is running (2026-11-23).
 * It checks nothing about the plays. The kind in the request picks the weeks:
 *  - track: first 2026-11-02, latest 2026-11-23: the latest week is the running one
 *  - artist: first, latest and current are all 2026-11-23: the running week is the only one
 *  - album: first 2026-11-09, latest 2026-11-16: the latest week is finished
 * Every chart it sends holds the same one row.
 */
function inProgressDatabase(): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    const server = createHttpServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        let args: { p_kind?: string } = {};
        try {
          args = JSON.parse(body || "{}") as typeof args;
        } catch {
          // A body that is not JSON gets the empty arguments.
        }
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        const current = "2026-11-23";
        if (req.url?.includes("/rpc/chart_bounds")) {
          if (args.p_kind === "artist") return send(200, [{ first_week: current, latest_week: current, current_week: current }]);
          if (args.p_kind === "album") return send(200, [{ first_week: "2026-11-09", latest_week: "2026-11-16", current_week: current }]);
          return send(200, [{ first_week: "2026-11-02", latest_week: current, current_week: current }]);
        }
        if (req.url?.includes("/rpc/chart_weekly")) {
          return send(200, [
            { rank: 1, key: "k", name: "Stand-in", artist: "Stand-in artist", plays: 3, minutes: 9, last_week_rank: 1, peak_rank: 1, weeks_on_chart: 4 },
          ]);
        }
        return send(404, { message: "not found" });
      });
    });
    server.on("error", reject);
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
  const stub = await stubDatabase();
  const inProgress = await inProgressDatabase();

  const [healthy, refused, hang, badKey, missingEnv, malformed, running] = await Promise.all([
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
    startSite(
      "malformed",
      siteEnv({ SUPABASE_URL: `http://127.0.0.1:${stub.port}`, SUPABASE_SERVICE_ROLE_KEY: serviceKey }),
    ),
    startSite(
      "inProgress",
      siteEnv({ SUPABASE_URL: `http://127.0.0.1:${inProgress.port}`, SUPABASE_SERVICE_ROLE_KEY: serviceKey }),
    ),
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
  process.env.TEST_SITE_MALFORMED_URL = malformed;
  process.env.TEST_SITE_INPROGRESS_URL = running;

  return stopAll;
}
