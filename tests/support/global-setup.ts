import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";

/**
 * Reads the local Supabase stack, then starts three copies of the site:
 *  - healthy: points at the real local database
 *  - refused: points at a port where nothing listens
 *  - hanging: points at a port that accepts a connection and never answers
 *
 * Keys are read from the Supabase CLI and kept in process memory.
 * They are never written to a file or printed.
 */

const children: ChildProcess[] = [];
const servers: Server[] = [];

function readSupabaseEnv(): Record<string, string> {
  let output: string;
  try {
    output = execFileSync("supabase", ["status", "-o", "env"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error(
      "Local Supabase is not running. Start it with `npm run db:start`, then run the tests again.",
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
    const sockets = new Set<import("node:net").Socket>();
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

async function startSite(name: string, supabaseUrl: string, serviceKey: string): Promise<string> {
  const port = await freePort();
  const child = spawn("node_modules/.bin/next", ["dev", "-p", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "development",
      NEXT_DIST_DIR: `.next-test-${name}`,
      NEXT_TELEMETRY_DISABLED: "1",
      SUPABASE_URL: supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  children.push(child);

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 100_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The ${name} site exited early.`);
    try {
      await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(20_000) });
      return url;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`The ${name} site did not start in time.`);
}

async function stopAll() {
  for (const child of children) child.kill("SIGTERM");
  for (const server of servers) server.close();
}

export default async function setup() {
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

  const deadPort = await freePort();
  const hanging = await hangingDatabase();

  const [healthy, refused, hang] = await Promise.all([
    startSite("healthy", apiUrl, serviceKey),
    startSite("refused", `http://127.0.0.1:${deadPort}`, serviceKey),
    startSite("hanging", `http://127.0.0.1:${hanging.port}`, serviceKey),
  ]);

  process.env.TEST_API_URL = apiUrl;
  process.env.TEST_DB_URL = dbUrl;
  process.env.TEST_ANON_KEY = anonKey;
  process.env.TEST_PUBLISHABLE_KEY = supa.PUBLISHABLE_KEY ?? "";
  process.env.TEST_SERVICE_ROLE_KEY = serviceKey;
  process.env.TEST_SITE_HEALTHY_URL = healthy;
  process.env.TEST_SITE_REFUSED_URL = refused;
  process.env.TEST_SITE_HANGING_URL = hang;

  return stopAll;
}
