import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { easternDate, generateFakePlays } from "../scripts/fake-plays";
import { clearPlays, withDb } from "./support/chart-data";
import { testEnv } from "./support/env";

/**
 * The seed command, run as a person would run it, against the local stack.
 * Rows are fake and removed after each test. The chart cases are read back through
 * the chart_weekly function, so they prove what the site will show.
 */
const env = testEnv();

function runSeed(overrides: Record<string, string | undefined>) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];
  const result = spawnSync(process.execPath, ["scripts/seed-fake-plays.ts"], {
    cwd: process.cwd(),
    env: childEnv,
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const LOCAL = { SUPABASE_URL: env.apiUrl, SUPABASE_SERVICE_ROLE_KEY: env.serviceRoleKey };

async function countPlays(): Promise<number> {
  return withDb(async (db) => Number((await db.query("select count(*) as n from public.plays")).rows[0].n));
}

beforeAll(clearPlays);
beforeEach(clearPlays);
afterAll(clearPlays);

describe("the seed command", () => {
  it("seeds every generated play, and a second run adds none", async () => {
    const expected = generateFakePlays({ today: easternDate(new Date()) }).length;

    const first = runSeed(LOCAL);
    expect(first.status, first.out).toBe(0);
    expect(await countPlays()).toBe(expected);
    expect(first.out).toContain(`inserted ${expected}`);

    const second = runSeed(LOCAL);
    expect(second.status, second.out).toBe(0);
    expect(await countPlays()).toBe(expected);
    expect(second.out).toContain("inserted 0");
  });

  it("finds the local stack itself when no address is given", async () => {
    const result = runSeed({ SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined });
    expect(result.status, result.out).toBe(0);
    expect(await countPlays()).toBeGreaterThan(8_000);
  });

  it("never prints the key or the address it was given", () => {
    const result = runSeed(LOCAL);
    expect(result.out).not.toContain(env.serviceRoleKey);
    expect(result.out).not.toContain(env.apiUrl);
  });

  it.each([
    "https://abcdefgh.supabase.co",
    "http://127.0.0.1.example.com:54321",
    "http://localhost@example.com",
  ])("refuses the address %s and writes nothing", async (url) => {
    const result = runSeed({ SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: env.serviceRoleKey });
    expect(result.status).not.toBe(0);
    expect(result.out).toMatch(/refus/i);
    expect(result.out).not.toContain(url);
    expect(await countPlays()).toBe(0);
  });

  it("refuses when an address is given with no key", async () => {
    const result = runSeed({ SUPABASE_URL: env.apiUrl, SUPABASE_SERVICE_ROLE_KEY: undefined });
    expect(result.status).not.toBe(0);
    expect(await countPlays()).toBe(0);
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

  async function recentCharts(kind: string): Promise<{ week: string; rows: Row[] }[]> {
    return withDb(async (db) => {
      const bounds = await db.query<{ latest: string }>(
        "select to_char(latest_week, 'YYYY-MM-DD') as latest from public.chart_bounds($1, 1)",
        [kind],
      );
      const latest = bounds.rows[0]!.latest;
      const out: { week: string; rows: Row[] }[] = [];
      for (let back = 0; back < 12; back++) {
        const week = (
          await db.query<{ week: string }>("select to_char($1::date - $2::integer, 'YYYY-MM-DD') as week", [
            latest,
            back * 7,
          ])
        ).rows[0]!.week;
        const chart = await db.query<Row>("select * from public.chart_weekly($1::date, $2, 100, 1)", [week, kind]);
        out.push({ week, rows: chart.rows });
      }
      return out;
    });
  }

  it("shows NEW, RE-ENTRY, a climb, a fall and a peak above the current rank in the last 12 weeks", async () => {
    expect(runSeed(LOCAL).status).toBe(0);
    const rows = (await recentCharts("track")).flatMap((c) => c.rows);

    const isNew = rows.filter((r) => r.last_week_rank === null && r.weeks_on_chart === 1);
    const reEntry = rows.filter((r) => r.last_week_rank === null && r.weeks_on_chart > 1);
    const climb = rows.filter((r) => r.last_week_rank !== null && r.rank < r.last_week_rank);
    const fall = rows.filter((r) => r.last_week_rank !== null && r.rank > r.last_week_rank);
    const peakAbove = rows.filter((r) => r.peak_rank < r.rank);

    expect(isNew.length).toBeGreaterThan(0);
    expect(reEntry.length).toBeGreaterThan(0);
    expect(climb.length).toBeGreaterThan(0);
    expect(fall.length).toBeGreaterThan(0);
    expect(peakAbove.length).toBeGreaterThan(0);
  });

  it("reaches number one with a climb, so the top row shows movement", async () => {
    expect(runSeed(LOCAL).status).toBe(0);
    const rows = (await recentCharts("track")).flatMap((c) => c.rows);
    expect(rows.some((r) => r.rank === 1 && r.last_week_rank !== null && r.last_week_rank > 1)).toBe(true);
  });

  it("leaves plays with no album out of the album chart, and short plays out of every chart", async () => {
    expect(runSeed(LOCAL).status).toBe(0);
    const [track] = await recentCharts("track");
    const [album] = await recentCharts("album");
    const sum = (rows: Row[]) => rows.reduce((total, r) => total + r.plays, 0);
    expect(sum(album!.rows)).toBeLessThan(sum(track!.rows));
    expect(album!.rows.length).toBeGreaterThan(5);

    // The track chart counts exactly the plays of 30 seconds or more, or with no length.
    const counted = await withDb(async (db) => {
      const result = await db.query<{ n: string }>(
        `select count(*) as n from public.plays p
          where (p.ms_played is null or p.ms_played >= 30000)
            and p.ended_at <= public.chart_cutoff(now(), 1)
            and date_trunc('week', p.ended_at at time zone 'America/New_York')::date = $1::date`,
        [track!.week],
      );
      return Number(result.rows[0]!.n);
    });
    expect(sum(track!.rows)).toBe(counted);
  });

  it("also fills the artist chart", async () => {
    expect(runSeed(LOCAL).status).toBe(0);
    const [artist] = await recentCharts("artist");
    expect(artist!.rows.length).toBeGreaterThan(5);
  });
});
