import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { easternDate, generateFakePlays } from "../scripts/fake-plays";
import { albumKey, clearPlays, insertPlays, play, withDb } from "./support/chart-data";
import { testEnv } from "./support/env";

/**
 * The seed command, run as a person would run it, against the local stack.
 * A test sets VITEST and SEED_NOW, which pins the command's clock, so no test depends on the real date.
 * Rows are fake and removed after each test. The chart cases are read back through the
 * chart_weekly function, so they prove what the site will show.
 */
const env = testEnv();
const SCRIPT = join(process.cwd(), "scripts", "seed-fake-plays.ts");

type Run = { status: number | null; out: string };

/** Runs the command without blocking this process, so a stub server in this process can still answer it. */
function runSeed(overrides: Record<string, string | undefined>, script: string = SCRIPT): Promise<Run> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd: process.cwd(), env: childEnv });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, out });
    });
  });
}

const LOCAL = { SUPABASE_URL: env.apiUrl, SUPABASE_SERVICE_ROLE_KEY: env.serviceRoleKey };
const pinned = (now: string) => ({ ...LOCAL, SEED_NOW: now });
const todayOf = (now: string) => easternDate(new Date(now));

async function countPlays(): Promise<number> {
  return withDb(async (db) => Number((await db.query("select count(*) as n from public.plays")).rows[0].n));
}

type Stub = { url: string; hits: IncomingMessage[]; close: () => Promise<void> };

async function stubServer(answer: (req: IncomingMessage, hit: number, res: import("node:http").ServerResponse) => void): Promise<Stub> {
  const hits: IncomingMessage[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(req);
    req.resume();
    req.on("end", () => answer(req, hits.length, res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

beforeAll(clearPlays);
beforeEach(clearPlays);
afterAll(clearPlays);

describe("the seed command", () => {
  it("replaces the fake plays, so a second run leaves one set", { timeout: 120_000 }, async () => {
    const now = "2026-04-08T16:00:00Z";
    const expected = generateFakePlays({ today: todayOf(now) }).length;

    const first = await runSeed(pinned(now));
    expect(first.status, first.out).toBe(0);
    expect(await countPlays()).toBe(expected);
    expect(first.out).toContain(`removed 0, inserted ${expected}`);

    const second = await runSeed(pinned(now));
    expect(second.status, second.out).toBe(0);
    expect(await countPlays()).toBe(expected);
    expect(second.out).toContain(`removed ${expected}, inserted ${expected}`);
  });

  it("leaves one clean set when it runs again in a later Eastern week", { timeout: 120_000 }, async () => {
    const weekA = "2026-03-04T16:00:00Z";
    const weekB = "2026-03-18T16:00:00Z";
    expect((await runSeed(pinned(weekA))).status).toBe(0);
    const secondRun = await runSeed(pinned(weekB));
    expect(secondRun.status, secondRun.out).toBe(0);

    const expected = generateFakePlays({ today: todayOf(weekB) });
    expect(await countPlays()).toBe(expected.length);
    const last = await withDb(async (db) =>
      (await db.query<{ last: Date }>("select max(ended_at) as last from public.plays")).rows[0]!.last,
    );
    expect(last.toISOString().slice(0, 10)).toBe("2026-03-17");
  });

  it("never touches a play that is not fake", async () => {
    await insertPlays([
      play("keep", "2026-01-05T15:00:00Z"),
      // A real-looking address that starts the same way is longer than a fake one, so it stays.
      { ...play("keep2", "2026-01-05T16:00:00Z"), track_uri: "spotify:track:fakeABCDEFGHIJKLMNOPQR" },
    ]);
    const result = await runSeed(pinned("2026-04-08T16:00:00Z"));
    expect(result.status, result.out).toBe(0);
    const kept = await withDb((db) =>
      db.query("select track_uri from public.plays where track_uri not like 'spotify:track:fake____' order by 1"),
    );
    expect(kept.rows.map((r) => r.track_uri)).toEqual([
      "spotify:track:fakeABCDEFGHIJKLMNOPQR",
      "spotify:track:synthetic-keep",
    ]);
  });

  it("finds the local stack itself when no address is given", async () => {
    const result = await runSeed({ SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined, SEED_NOW: "2026-04-08T16:00:00Z" });
    expect(result.status, result.out).toBe(0);
    expect(await countPlays()).toBeGreaterThan(5_000);
  });

  it("ignores SEED_NOW unless a test set VITEST", async () => {
    const result = await runSeed({ ...pinned("2020-01-08T16:00:00Z"), VITEST: undefined });
    expect(result.status, result.out).toBe(0);
    const last = await withDb(async (db) =>
      (await db.query<{ last: Date }>("select max(ended_at) as last from public.plays")).rows[0]!.last,
    );
    expect(last.getUTCFullYear()).toBeGreaterThanOrEqual(2026);
  });

  it("never prints the key or the address it was given", async () => {
    const result = await runSeed(pinned("2026-04-08T16:00:00Z"));
    expect(result.out).not.toContain(env.serviceRoleKey);
    expect(result.out).not.toContain(env.apiUrl);
  });

  it.each([
    "https://abcdefgh.supabase.co",
    "http://127.0.0.1.example.com:54321",
    "http://localhost@example.com",
    "http://localhost.:54321",
    "http://[::1]:54321",
  ])("refuses the address %s and writes nothing", async (url) => {
    const result = await runSeed({ SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: env.serviceRoleKey });
    expect(result.status).not.toBe(0);
    expect(result.out).toMatch(/refus/i);
    expect(result.out).not.toContain(url);
    expect(result.out).not.toContain(env.serviceRoleKey);
    expect(await countPlays()).toBe(0);
  });

  it("refuses when an address is given with no key", async () => {
    const result = await runSeed({ SUPABASE_URL: env.apiUrl, SUPABASE_SERVICE_ROLE_KEY: undefined });
    expect(result.status).not.toBe(0);
    expect(await countPlays()).toBe(0);
  });

  it("runs when started through a symlink, and still refuses a hosted address", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hanna-fm-seed-link-"));
    try {
      const link = join(dir, "seed.ts");
      symlinkSync(SCRIPT, link);
      const refused = await runSeed({ SUPABASE_URL: "https://abcdefgh.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" }, link);
      expect(refused.status).toBe(1);
      expect(refused.out).toMatch(/refused/i);

      const seeded = await runSeed(pinned("2026-04-08T16:00:00Z"), link);
      expect(seeded.status, seeded.out).toBe(0);
      expect(seeded.out).toContain("inserted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a database that is not the database", () => {
  it.each([307, 301, 302, 308])("fails on a %s redirect and sends nothing onward", async (code) => {
    const elsewhere = await stubServer((_req, _hit, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
    });
    const bouncer = await stubServer((_req, _hit, res) => {
      res.writeHead(code, { Location: `${elsewhere.url}/rest/v1/plays` });
      res.end();
    });
    try {
      const result = await runSeed({ SUPABASE_URL: bouncer.url, SUPABASE_SERVICE_ROLE_KEY: env.serviceRoleKey });
      expect(result.status).toBe(1);
      expect(result.out).toMatch(/request to the database failed/i);
      expect(result.out).not.toContain(env.serviceRoleKey);
      // The first process saw one request, and the second saw none: the key and the rows stayed put.
      expect(bouncer.hits).toHaveLength(1);
      expect(elsewhere.hits).toHaveLength(0);
    } finally {
      await bouncer.close();
      await elsewhere.close();
    }
  });

  it("says how many plays were stored when a batch fails", async () => {
    const stub = await stubServer((req, hit, res) => {
      res.writeHead(req.method === "POST" && hit > 2 ? 500 : 200, { "Content-Type": "application/json" });
      res.end(req.method === "DELETE" ? "[]" : JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ id: i }))));
    });
    try {
      const result = await runSeed({ SUPABASE_URL: stub.url, SUPABASE_SERVICE_ROLE_KEY: env.serviceRoleKey, SEED_NOW: "2026-04-08T16:00:00Z" });
      expect(result.status).toBe(1);
      // Request 1 is the delete, request 2 stores 500, request 3 fails.
      expect(result.out).toContain("HTTP 500");
      expect(result.out).toContain("Stored before the failure: 500");
    } finally {
      await stub.close();
    }
  });
});

describe("when the Supabase CLI cannot help", () => {
  function fakeCli(script: string): string {
    const dir = mkdtempSync(join(tmpdir(), "hanna-fm-fake-cli-"));
    const file = join(dir, "supabase");
    writeFileSync(file, `#!/bin/sh\n${script}\n`);
    chmodSync(file, 0o755);
    return dir;
  }
  const noAddress = { SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined };

  it("names a missing CLI", async () => {
    const empty = mkdtempSync(join(tmpdir(), "hanna-fm-empty-path-"));
    try {
      const result = await runSeed({ ...noAddress, PATH: empty });
      expect(result.status).toBe(1);
      expect(result.out).toMatch(/CLI was not found/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("names a CLI that exits with an error", async () => {
    const dir = fakeCli("exit 3");
    try {
      const result = await runSeed({ ...noAddress, PATH: dir });
      expect(result.status).toBe(1);
      expect(result.out).toMatch(/did not answer.*exited with 3/);
      expect(result.out).not.toMatch(/was not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names a CLI that prints nothing useful", async () => {
    const dir = fakeCli("echo hello");
    try {
      const result = await runSeed({ ...noAddress, PATH: dir });
      expect(result.status).toBe(1);
      expect(result.out).toMatch(/did not report the local address/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the seeded data through the chart_weekly function", () => {
  type Row = {
    rank: number;
    key: string;
    name: string;
    plays: number;
    last_week_rank: number | null;
    peak_rank: number;
    weeks_on_chart: number;
  };
  type Kind = "track" | "artist" | "album";

  /** The chart for the completed week `back` weeks before the current one, as the site would show it at `now`. */
  async function chart(kind: Kind, back: number, now: string): Promise<{ week: string; rows: Row[] }> {
    return withDb(async (db) => {
      const week = (
        await db.query<{ week: string }>(
          `select to_char(current_week - $2::integer, 'YYYY-MM-DD') as week from public.chart_bounds($1, 1, $3::timestamptz)`,
          [kind, back * 7, now],
        )
      ).rows[0]!.week;
      const result = await db.query<Row>("select * from public.chart_weekly($1::date, $2, 100, 1, $3::timestamptz)", [week, kind, now]);
      return { week, rows: result.rows };
    });
  }

  const track = (n: number) => `spotify:track:fake${String(n).padStart(4, "0")}`;
  const artist = (n: number) => `Fake Artist ${String(n).padStart(2, "0")}`;
  const album = (n: number) => albumKey(`Fake Album ${String(n).padStart(2, "0")}`, artist(n));

  const isNew = (r: Row) => r.last_week_rank === null && r.weeks_on_chart === 1;
  const isReEntry = (r: Row) => r.last_week_rank === null && r.weeks_on_chart > 1;
  const isClimb = (r: Row) => r.last_week_rank !== null && r.rank < r.last_week_rank;
  const isFall = (r: Row) => r.last_week_rank !== null && r.rank > r.last_week_rank;
  const isPeakAbove = (r: Row) => r.peak_rank < r.rank;

  // [chart, weeks back, key, what the row must be]. These are the cases the default view must show, each by name.
  const CASES: [Kind, number, string, string, (r: Row) => boolean][] = [
    ["track", 3, track(5), "NEW", isNew],
    ["track", 2, track(8), "NEW", isNew],
    ["track", 3, track(4), "RE-ENTRY", isReEntry],
    ["track", 3, track(7), "RE-ENTRY", isReEntry],
    ["track", 2, track(2), "a climb to number one", (r) => isClimb(r) && r.rank === 1],
    ["track", 3, track(3), "a fall", isFall],
    ["track", 1, track(3), "a peak above the current rank", isPeakAbove],
    ["artist", 2, artist(5), "NEW", isNew],
    ["artist", 3, artist(4), "RE-ENTRY", isReEntry],
    ["artist", 1, artist(4), "a climb", isClimb],
    ["artist", 1, artist(2), "a fall", isFall],
    ["artist", 1, artist(2), "a peak above the current rank", isPeakAbove],
    ["album", 2, album(5), "NEW", isNew],
    ["album", 3, album(4), "RE-ENTRY", isReEntry],
    ["album", 1, album(4), "a climb", isClimb],
    ["album", 1, album(2), "a fall", isFall],
    ["album", 1, album(2), "a peak above the current rank", isPeakAbove],
  ];

  // One run day for each day of the week, Monday 6 April to Sunday 12 April 2026, at noon in New York.
  const RUN_DAYS = [
    ["Monday", "2026-04-06T16:00:00Z"],
    ["Tuesday", "2026-04-07T16:00:00Z"],
    ["Wednesday", "2026-04-08T16:00:00Z"],
    ["Thursday", "2026-04-09T16:00:00Z"],
    ["Friday", "2026-04-10T16:00:00Z"],
    ["Saturday", "2026-04-11T16:00:00Z"],
    ["Sunday", "2026-04-12T16:00:00Z"],
  ] as const;

  it.each(RUN_DAYS)(
    "shows each chart case, by name, on all three charts in the last three completed weeks, for a run on a %s",
    { timeout: 120_000 },
    async (_day, now) => {
      expect((await runSeed(pinned(now))).status).toBe(0);
      const charts = new Map<string, Row[]>();
      for (const kind of ["track", "artist", "album"] as const) {
        for (const back of [1, 2, 3]) charts.set(`${kind}:${back}`, (await chart(kind, back, now)).rows);
      }
      for (const [kind, back, key, label, holds] of CASES) {
        const row = charts.get(`${kind}:${back}`)!.find((r) => r.key === key);
        expect(row, `${kind} chart, ${back} weeks back: ${key} should be on the chart`).toBeDefined();
        expect(holds(row!), `${kind} chart, ${back} weeks back: ${key} should be ${label}: ${JSON.stringify(row)}`).toBe(true);
      }
    },
  );

  it("counts short plays out, and counts every other play, in a week that holds short plays", async () => {
    const now = "2026-04-08T16:00:00Z";
    expect((await runSeed(pinned(now))).status).toBe(0);
    const { week, rows } = await chart("track", 2, now);
    const counts = await withDb(async (db) => {
      const result = await db.query<{ short: string; counted: string }>(
        `select count(*) filter (where p.ms_played < 30000) as short,
                count(*) filter (where p.ms_played is null or p.ms_played >= 30000) as counted
           from public.plays p
          where p.ended_at <= public.chart_cutoff($2::timestamptz, 1)
            and date_trunc('week', p.ended_at at time zone 'America/New_York')::date = $1::date`,
        [week, now],
      );
      return { short: Number(result.rows[0]!.short), counted: Number(result.rows[0]!.counted) };
    });
    expect(counts.short).toBeGreaterThan(0);
    expect(counts.counted).toBeGreaterThan(100);
    expect(rows.reduce((total, r) => total + r.plays, 0)).toBe(counts.counted);
  });

  it("leaves plays with no album out of the album chart", async () => {
    const now = "2026-04-08T16:00:00Z";
    expect((await runSeed(pinned(now))).status).toBe(0);
    const trackChart = await chart("track", 2, now);
    const albumChart = await chart("album", 2, now);
    const sum = (rows: Row[]) => rows.reduce((total, r) => total + r.plays, 0);
    const noAlbum = await withDb(async (db) => {
      const result = await db.query<{ n: string }>(
        `select count(*) as n from public.plays p
          where p.album_name is null and (p.ms_played is null or p.ms_played >= 30000)
            and p.ended_at <= public.chart_cutoff($2::timestamptz, 1)
            and date_trunc('week', p.ended_at at time zone 'America/New_York')::date = $1::date`,
        [trackChart.week, now],
      );
      return Number(result.rows[0]!.n);
    });
    expect(noAlbum).toBeGreaterThan(0);
    expect(sum(albumChart.rows)).toBe(sum(trackChart.rows) - noAlbum);
  });
});
