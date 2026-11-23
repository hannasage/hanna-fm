import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearPlays, insertPlays, play, serviceHeaders, withDb } from "./support/chart-data";
import { testEnv } from "./support/env";

/**
 * The chart functions called straight in the database, with a fixed clock (`p_now`).
 * Every expected date and instant is written out by hand. Nothing here reads the real clock
 * except the timeout probe, which only measures a duration.
 * Plays are synthetic and removed after each test.
 */
const env = testEnv();

type Row = { rank: number; name: string; plays: number; minutes: number };

/** The chart for one week as the database would answer at the moment `now`, with the 1 day delay. */
async function chartAt(db: Client, now: string, week: string, kind = "track"): Promise<Row[]> {
  const result = await db.query<Row>(
    "select rank, name, plays, minutes from public.chart_weekly($1::date, $2, 25, 1, $3::timestamptz)",
    [week, kind, now],
  );
  return result.rows;
}

async function boundsAt(db: Client, now: string, kind = "track") {
  const result = await db.query<{ first_week: string | null; latest_week: string | null; current_week: string }>(
    `select to_char(first_week, 'YYYY-MM-DD') as first_week,
            to_char(latest_week, 'YYYY-MM-DD') as latest_week,
            to_char(current_week, 'YYYY-MM-DD') as current_week
       from public.chart_bounds($1, 1, $2::timestamptz)`,
    [kind, now],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

beforeAll(clearPlays);
beforeEach(clearPlays);
afterAll(clearPlays);

describe("the public delay snaps to the start of the previous Eastern day", () => {
  // Each pair is a moment and the cutoff the delay gives it: midnight starting the previous New York day.
  it.each<[string, string, string]>([
    ["midday in standard time", "2026-02-18T15:00:00Z", "2026-02-17T05:00:00.000Z"],
    ["one second before Eastern midnight", "2026-02-19T04:59:59Z", "2026-02-17T05:00:00.000Z"],
    ["at Eastern midnight", "2026-02-19T05:00:00Z", "2026-02-18T05:00:00.000Z"],
    ["just before the spring forward day ends", "2026-03-09T03:59:59Z", "2026-03-07T05:00:00.000Z"],
    // The day before is only 23 hours long, so the cutoff goes back one more day to stay 24 hours behind.
    ["at midnight after the spring forward day", "2026-03-09T04:00:00Z", "2026-03-07T05:00:00.000Z"],
    ["the day after spring forward", "2026-03-10T04:00:00Z", "2026-03-09T04:00:00.000Z"],
    ["on the fall back day", "2026-11-01T12:00:00Z", "2026-10-31T04:00:00.000Z"],
    ["at midnight after the fall back day", "2026-11-02T05:00:00Z", "2026-11-01T04:00:00.000Z"],
  ])("gives the cutoff for %s", async (_label, now, expected) => {
    await withDb(async (db) => {
      const result = await db.query<{ cutoff: Date }>(
        "select public.chart_cutoff($1::timestamptz, 1) as cutoff",
        [now],
      );
      expect(result.rows[0]!.cutoff.toISOString()).toBe(expected);
    });
  });

  // The delay counts Eastern calendar days, so a clock change adds or removes no day.
  it.each<[string, number, string, string]>([
    ["2 days, the day after spring forward", 2, "2026-03-09T04:00:00Z", "2026-03-07T05:00:00.000Z"],
    ["2 days, two days after spring forward", 2, "2026-03-10T04:00:00Z", "2026-03-08T05:00:00.000Z"],
    ["2 days, three days after spring forward", 2, "2026-03-11T04:00:00Z", "2026-03-09T04:00:00.000Z"],
    ["3 days, three days after spring forward", 3, "2026-03-11T04:00:00Z", "2026-03-08T05:00:00.000Z"],
    ["7 days, a week across spring forward", 7, "2026-03-12T04:00:00Z", "2026-03-05T05:00:00.000Z"],
    ["2 days, midday on the fall back day", 2, "2026-11-01T16:00:00Z", "2026-10-30T04:00:00.000Z"],
    ["2 days, the Monday after fall back", 2, "2026-11-02T05:00:00Z", "2026-10-31T04:00:00.000Z"],
    ["2 days, the Tuesday after fall back", 2, "2026-11-03T05:00:00Z", "2026-11-01T04:00:00.000Z"],
    ["3 days, the Wednesday after fall back", 3, "2026-11-04T05:00:00Z", "2026-11-01T04:00:00.000Z"],
    ["7 days, a week across fall back", 7, "2026-11-05T05:00:00Z", "2026-10-29T04:00:00.000Z"],
  ])("counts Eastern calendar days, not 24 hour blocks: %s", async (_label, days, now, expected) => {
    await withDb(async (db) => {
      const result = await db.query<{ cutoff: Date }>(
        "select public.chart_cutoff($1::timestamptz, $2::int) as cutoff",
        [now, days],
      );
      expect(result.rows[0]!.cutoff.toISOString()).toBe(expected);
    });
  });

  it("is always an Eastern midnight, and always the stated number of dates back once the delay is over one day", async () => {
    await withDb(async (db) => {
      // Every hour of a year, for delays of 2 to 7 days. A drifting cutoff would land on 23:00 or 01:00.
      const result = await db.query<{ bad: string }>(
        `select count(*) as bad
           from generate_series('2026-01-01T00:00:00Z'::timestamptz, '2026-12-31T00:00:00Z', interval '1 hour') as t,
                generate_series(2, 7) as d
          where (public.chart_cutoff(t, d) at time zone 'America/New_York')::time <> '00:00'
             or (public.chart_cutoff(t, d) at time zone 'America/New_York')::date
                <> (t at time zone 'America/New_York')::date - d`,
      );
      expect(Number(result.rows[0]!.bad)).toBe(0);
    });
  });

  it.each<[string, number | null]>([
    ["zero", 0],
    ["a negative number", -1],
    ["null", null],
  ])("refuses a delay of %s days", async (_label, days) => {
    await withDb(async (db) => {
      await expect(db.query("select public.chart_cutoff('2026-02-18T15:00:00Z'::timestamptz, $1::int)", [days])).rejects.toMatchObject({
        message: expect.stringContaining("delay"),
      });
    });
  });

  it("accepts a delay of exactly one day", async () => {
    await withDb(async (db) => {
      const result = await db.query<{ cutoff: Date }>("select public.chart_cutoff('2026-02-18T15:00:00Z'::timestamptz, 1) as cutoff");
      expect(result.rows[0]!.cutoff.toISOString()).toBe("2026-02-17T05:00:00.000Z");
    });
  });

  it.each([0, -1])("makes chart_weekly and chart_bounds refuse a delay of %i days, even with no plays stored", async (days) => {
    await withDb(async (db) => {
      await expect(
        db.query("select * from public.chart_weekly('2026-02-02'::date, 'track', 25, $1::int, '2026-02-18T15:00:00Z'::timestamptz)", [days]),
      ).rejects.toMatchObject({ message: expect.stringContaining("delay") });
      await expect(
        db.query("select * from public.chart_bounds('track', $1::int, '2026-02-18T15:00:00Z'::timestamptz)", [days]),
      ).rejects.toMatchObject({ message: expect.stringContaining("delay") });
    });
  });

  it("always holds a play back for at least 24 hours", async () => {
    await withDb(async (db) => {
      // Every hour across two clock changes and a month end. The gap is never under 24 hours.
      const result = await db.query<{ worst_gap_hours: string }>(
        `select min(extract(epoch from (t - public.chart_cutoff(t, 1))) / 3600) as worst_gap_hours
           from generate_series('2026-03-06T00:00:00Z'::timestamptz, '2026-03-12T00:00:00Z', interval '1 hour') as t`,
      );
      expect(Number(result.rows[0]!.worst_gap_hours)).toBeGreaterThanOrEqual(24);
    });
  });

  it("shows a play at the cutoff and hides one a second later, in standard time", async () => {
    await insertPlays([
      play("before", "2026-02-17T04:59:59Z"),
      play("at", "2026-02-17T05:00:00Z"),
      play("after", "2026-02-17T05:00:01Z"),
    ]);
    await withDb(async (db) => {
      const rows = await chartAt(db, "2026-02-18T15:00:00Z", "2026-02-16");
      expect(rows.map((r) => r.name)).toEqual(["Track at", "Track before"]);
    });
  });

  it("goes back one more day at midnight after spring forward, so no play is under 24 hours old", async () => {
    // Sunday 2026-03-08 is 23 hours long. At Monday 00:00 EDT (04:00 UTC) a play from Sunday 00:00 EST
    // is only 23 hours old, so the cutoff is Saturday 00:00 EST (2026-03-07T05:00Z).
    await insertPlays([
      play("saturday", "2026-03-07T04:59:59Z"),
      play("satlate", "2026-03-08T04:30:00Z"),
      play("sunday", "2026-03-08T05:00:00Z"),
    ]);
    await withDb(async (db) => {
      const rows = await chartAt(db, "2026-03-09T04:00:00Z", "2026-03-02");
      expect(rows.map((r) => r.name)).toEqual(["Track saturday"]);
    });
  });

  it("uses the standard cutoff after fall back", async () => {
    await insertPlays([play("before", "2026-11-01T03:59:59Z"), play("after", "2026-11-01T04:00:01Z")]);
    await withDb(async (db) => {
      const rows = await chartAt(db, "2026-11-02T05:00:00Z", "2026-10-26");
      expect(rows.map((r) => r.name)).toEqual(["Track before"]);
    });
  });

  it("lets a caller polling all day see no play arrive at its own time, only a step at Eastern midnight", async () => {
    // One play an hour from Monday 2026-02-16 00:00 EST. A caller polls the current week every
    // hour from 2026-02-17T00:00Z to 2026-02-20T00:00Z.
    const start = Date.parse("2026-02-16T05:00:00Z");
    const hour = 3_600_000;
    await insertPlays(
      Array.from({ length: 120 }, (_, i) => play("p", new Date(start + i * hour).toISOString())),
    );

    await withDb(async (db) => {
      let previous: { now: number; plays: number; minutes: number } | null = null;
      const steps: string[] = [];
      for (let now = Date.parse("2026-02-17T00:00:00Z"); now <= Date.parse("2026-02-20T00:00:00Z"); now += hour) {
        const rows = await chartAt(db, new Date(now).toISOString(), "2026-02-16");
        const plays = rows[0]?.plays ?? 0;
        const minutes = rows[0]?.minutes ?? 0;

        // Every visible play is at least 24 hours old.
        if (plays > 0) {
          const newest = start + (plays - 1) * hour;
          expect(now - newest, `at ${new Date(now).toISOString()}`).toBeGreaterThanOrEqual(24 * hour);
        }
        // A number moves only on the hour that starts an Eastern day (05:00 UTC in February).
        if (previous && (plays !== previous.plays || minutes !== previous.minutes)) {
          steps.push(new Date(now).toISOString());
        }
        previous = { now, plays, minutes };
      }
      expect(steps).toEqual(["2026-02-17T05:00:00.000Z", "2026-02-18T05:00:00.000Z", "2026-02-19T05:00:00.000Z"]);
    });
  });

  it("gives hand-checked counts at the edges of one Eastern day", async () => {
    const start = Date.parse("2026-02-16T05:00:00Z");
    await insertPlays(
      Array.from({ length: 120 }, (_, i) => play("p", new Date(start + i * 3_600_000).toISOString())),
    );
    await withDb(async (db) => {
      // Cutoff 2026-02-17T05:00Z holds the plays from 02-16T05:00Z to 02-17T05:00Z: 25 plays, 5,000,000 ms.
      expect(await chartAt(db, "2026-02-18T05:00:00Z", "2026-02-16")).toMatchObject([{ plays: 25, minutes: 83 }]);
      expect(await chartAt(db, "2026-02-19T04:59:59Z", "2026-02-16")).toMatchObject([{ plays: 25, minutes: 83 }]);
      // At Eastern midnight the cutoff moves to 02-18T05:00Z: 49 plays, 9,800,000 ms.
      expect(await chartAt(db, "2026-02-19T05:00:00Z", "2026-02-16")).toMatchObject([{ plays: 49, minutes: 163 }]);
    });
  });
});

describe("chart_bounds with a fixed clock", () => {
  async function loadHistory() {
    await insertPlays([
      play("early", "2026-02-04T12:00:00Z"),
      play("mid", "2026-02-18T12:00:00Z"),
      play("noalbum", "2026-03-04T12:00:00Z", { album_name: null }),
      play("short", "2026-03-10T12:00:00Z", { ms_played: 10_000 }),
      play("fresh", "2026-03-11T12:00:00Z"),
    ]);
  }

  it("gives the first week, the latest qualifying track week and the current week", async () => {
    await loadHistory();
    await withDb(async (db) => {
      // Thursday 2026-03-12 11:00 EDT. The cutoff is Wednesday 2026-03-11 00:00 EDT.
      expect(await boundsAt(db, "2026-03-12T15:00:00Z", "track")).toEqual({
        first_week: "2026-02-02",
        latest_week: "2026-03-02",
        current_week: "2026-03-09",
      });
    });
  });

  it("skips plays with no album for the latest album week", async () => {
    await loadHistory();
    await withDb(async (db) => {
      expect(await boundsAt(db, "2026-03-12T15:00:00Z", "album")).toEqual({
        first_week: "2026-02-02",
        latest_week: "2026-02-16",
        current_week: "2026-03-09",
      });
    });
  });

  it("does not let a play under 30 seconds, or one inside the delay, set the latest week", async () => {
    await insertPlays([
      play("real", "2026-03-03T12:00:00Z"),
      play("short", "2026-03-10T12:00:00Z", { ms_played: 29_999 }),
      play("fresh", "2026-03-11T12:00:00Z"),
    ]);
    await withDb(async (db) => {
      expect((await boundsAt(db, "2026-03-12T15:00:00Z")).latest_week).toBe("2026-03-02");
    });
  });

  it("counts a poll row with no ms_played, as the chart does", async () => {
    await insertPlays([
      play("real", "2026-03-03T12:00:00Z"),
      play("poll", "2026-03-10T12:00:00Z", { source: "poll", ms_played: null }),
    ]);
    await withDb(async (db) => {
      expect((await boundsAt(db, "2026-03-12T15:00:00Z")).latest_week).toBe("2026-03-09");
    });
  });

  it("gives no first week and no latest week when no play is stored, and still gives the current week", async () => {
    await withDb(async (db) => {
      expect(await boundsAt(db, "2026-03-12T15:00:00Z")).toEqual({
        first_week: null,
        latest_week: null,
        current_week: "2026-03-09",
      });
    });
  });

  it("gives no first week and no latest week when every play is hidden or short", async () => {
    await insertPlays([play("fresh", "2026-03-11T12:00:00Z"), play("short", "2026-03-04T12:00:00Z", { ms_played: 1 })]);
    await withDb(async (db) => {
      expect(await boundsAt(db, "2026-03-12T15:00:00Z")).toEqual({
        first_week: null,
        latest_week: null,
        current_week: "2026-03-09",
      });
    });
  });

  it("does not let a play under 30 seconds, older than every visible play, move the first week", async () => {
    await insertPlays([
      play("short", "2026-01-06T12:00:00Z", { ms_played: 29_999 }),
      play("visible", "2026-02-18T12:00:00Z"),
    ]);
    await withDb(async (db) => {
      expect((await boundsAt(db, "2026-03-12T15:00:00Z")).first_week).toBe("2026-02-16");
    });
  });

  it("lets a play of exactly 30 seconds, and a poll row with no ms_played, set the first week", async () => {
    await insertPlays([
      play("exact", "2026-01-06T12:00:00Z", { ms_played: 30_000 }),
      play("poll", "2026-01-20T12:00:00Z", { source: "poll", ms_played: null }),
    ]);
    await withDb(async (db) => {
      expect((await boundsAt(db, "2026-03-12T15:00:00Z")).first_week).toBe("2026-01-05");
    });
    await clearPlays();
    await insertPlays([
      play("short", "2026-01-06T12:00:00Z", { ms_played: 29_999 }),
      play("poll", "2026-01-20T12:00:00Z", { source: "poll", ms_played: null }),
    ]);
    await withDb(async (db) => {
      expect((await boundsAt(db, "2026-03-12T15:00:00Z")).first_week).toBe("2026-01-19");
    });
  });

  it("does not let an album-less play, older than every album play, move the first week of an album chart", async () => {
    await insertPlays([
      play("single", "2026-01-06T12:00:00Z", { album_name: null }),
      play("album", "2026-02-18T12:00:00Z"),
    ]);
    await withDb(async (db) => {
      expect((await boundsAt(db, "2026-03-12T15:00:00Z", "album")).first_week).toBe("2026-02-16");
      // The same play counts for a track chart and an artist chart.
      expect((await boundsAt(db, "2026-03-12T15:00:00Z", "track")).first_week).toBe("2026-01-05");
      expect((await boundsAt(db, "2026-03-12T15:00:00Z", "artist")).first_week).toBe("2026-01-05");
    });
  });

  it("does not let a play inside the delay set the first week", async () => {
    // The cutoff at this moment is 2026-03-11 00:00 EDT. The only play is a second after it.
    await insertPlays([play("fresh", "2026-03-11T04:00:01Z")]);
    await withDb(async (db) => {
      expect((await boundsAt(db, "2026-03-12T15:00:00Z")).first_week).toBeNull();
    });
  });

  it("takes the first week from a play exactly at the cutoff", async () => {
    await insertPlays([play("at", "2026-03-11T04:00:00Z")]);
    await withDb(async (db) => {
      expect((await boundsAt(db, "2026-03-12T15:00:00Z")).first_week).toBe("2026-03-09");
    });
  });

  it.each<[string, string, string]>([
    ["Sunday 23:59:59 in daylight time", "2026-03-09T03:59:59Z", "2026-03-02"],
    ["Monday 00:00:00 in daylight time", "2026-03-09T04:00:00Z", "2026-03-09"],
    ["Sunday 23:59:59 in standard time", "2026-02-16T04:59:59Z", "2026-02-09"],
    ["Monday 00:00:00 in standard time", "2026-02-16T05:00:00Z", "2026-02-16"],
  ])("changes the current week at Eastern midnight on Monday: %s", async (_label, now, expected) => {
    await withDb(async (db) => {
      expect((await boundsAt(db, now)).current_week).toBe(expected);
    });
  });
});

describe("the chart functions in the database", () => {
  const functions = ["chart_weekly", "chart_bounds", "chart_cutoff"];

  it("are executable by the service role only", async () => {
    await withDb(async (db) => {
      const result = await db.query<{ fn: string; role: string; allowed: boolean }>(
        `select p.proname as fn, r.role, has_function_privilege(r.role, p.oid, 'EXECUTE') as allowed
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           cross join (values ('anon'), ('authenticated'), ('service_role')) as r(role)
          where n.nspname = 'public' and p.proname = any($1)
          order by p.proname, r.role`,
        [functions],
      );
      expect(result.rows).toEqual(
        [...functions].sort().flatMap((fn) => [
          { fn, role: "anon", allowed: false },
          { fn, role: "authenticated", allowed: false },
          { fn, role: "service_role", allowed: true },
        ]),
      );
    });
  });

  it("carries a 5 second statement timeout on the two that read plays", async () => {
    await withDb(async (db) => {
      const result = await db.query<{ proname: string; proconfig: string[] | null }>(
        `select p.proname, p.proconfig
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname in ('chart_weekly', 'chart_bounds')
          order by p.proname`,
      );
      expect(result.rows.map((r) => r.proname)).toEqual(["chart_bounds", "chart_weekly"]);
      for (const row of result.rows) {
        expect(row.proconfig, row.proname).toContain("statement_timeout=5s");
      }
    });
  });

  it("stop a query at the function's timeout when the request arrives through the API", async () => {
    // A function setting is not applied to a statement that is already running in plain SQL. It is
    // applied when PostgREST calls the function, which is how the site calls it. The probe is a
    // slow function that carries the same setting the chart functions carry, read from the catalog.
    const setting = await withDb(async (db) => {
      const result = await db.query<{ proconfig: string[] }>(
        "select proconfig from pg_proc where proname = 'chart_weekly' and pronamespace = 'public'::regnamespace",
      );
      const found = result.rows[0]?.proconfig.find((entry) => entry.startsWith("statement_timeout="));
      expect(found).toBeDefined();
      return found!.slice("statement_timeout=".length);
    });
    expect(setting).toBe("5s");

    await withDb((db) =>
      db.query(
        `create or replace function public.chart_timeout_probe() returns integer
           language sql stable set statement_timeout = '${setting}'
           as $$ select 1 from pg_sleep(12) $$;
         grant execute on function public.chart_timeout_probe() to service_role;`,
      ),
    );
    try {
      let status = 0;
      let body: { code?: string } = {};
      let elapsed = 0;
      // PostgREST learns of a new function a moment after it is created.
      for (let attempt = 0; attempt < 20; attempt++) {
        const started = performance.now();
        const res = await fetch(`${env.apiUrl}/rest/v1/rpc/chart_timeout_probe`, {
          method: "POST",
          headers: serviceHeaders(),
          body: "{}",
        });
        elapsed = performance.now() - started;
        status = res.status;
        body = (await res.json().catch(() => ({}))) as { code?: string };
        if (status !== 404) break;
        await new Promise((r) => setTimeout(r, 250));
      }

      expect(body.code).toBe("57014");
      expect(status).toBe(500);
      expect(elapsed).toBeGreaterThan(4_000);
      expect(elapsed).toBeLessThan(8_000);
    } finally {
      await withDb((db) => db.query("drop function if exists public.chart_timeout_probe()"));
    }
  });
});
