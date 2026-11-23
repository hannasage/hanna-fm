import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  albumKey,
  clearPlays,
  insertPlays,
  play,
  plays,
  withDb,
  type Chart,
} from "./support/chart-data";
import { testEnv } from "./support/env";

/**
 * The artist name on a chart row, and the first and latest week on the chart answer.
 * Part one calls `chart_weekly` and `chart_bounds` in the database with a fixed clock.
 * Part two calls the site over HTTP. Every play is synthetic and removed after each test.
 */
const env = testEnv();

/** Thursday 2026-03-12 11:00 Eastern. The public cutoff is Wednesday 2026-03-11 00:00 Eastern. */
const NOW = "2026-03-12T15:00:00Z";

type ArtistRow = { key: string; name: string; artist: string | null; plays: number };

async function chartAt(db: Client, week: string, kind = "track", now = NOW): Promise<ArtistRow[]> {
  const result = await db.query<ArtistRow>(
    "select key, name, artist, plays from public.chart_weekly($1::date, $2, 25, 1, $3::timestamptz)",
    [week, kind, now],
  );
  return result.rows;
}

async function artistOf(week: string, uri: string, now = NOW): Promise<string | null | undefined> {
  return withDb(async (db) => (await chartAt(db, week, "track", now)).find((r) => r.key === uri)?.artist);
}

/** One track played under more than one artist name. The URI is the same, so the chart key is the same. */
const SHARED_URI = "spotify:track:synthetic-shared";
function shared(artist: string, endedAt: string, overrides: Parameters<typeof play>[2] = {}) {
  return play("shared", endedAt, { track_uri: SHARED_URI, track_name: "Shared Song", artist_name: artist, ...overrides });
}

beforeAll(clearPlays);
beforeEach(clearPlays);
afterAll(clearPlays);

describe("chart_weekly: the artist column", () => {
  it("returns the artist name for a track row, for an album row and as null for an artist row", async () => {
    await insertPlays([play("x", "2026-02-03T12:00:00Z", { artist_name: "Band X", album_name: "Record X" })]);
    await withDb(async (db) => {
      expect(await chartAt(db, "2026-02-02", "track")).toEqual([
        { key: "spotify:track:synthetic-x", name: "Track x", artist: "Band X", plays: 1 },
      ]);
      expect(await chartAt(db, "2026-02-02", "album")).toEqual([
        { key: albumKey("Record X", "Band X"), name: "Record X - Band X", artist: "Band X", plays: 1 },
      ]);
      expect(await chartAt(db, "2026-02-02", "artist")).toEqual([
        { key: "Band X", name: "Band X", artist: null, plays: 1 },
      ]);
    });
  });

  it("gives each album row its own artist when two artists share an album name", async () => {
    await insertPlays([
      ...plays("one", 2, "2026-02-03T12:00:00Z", { artist_name: "Band One", album_name: "Same Name" }),
      play("two", "2026-02-03T13:00:00Z", { artist_name: "Band Two", album_name: "Same Name" }),
    ]);
    await withDb(async (db) => {
      const rows = await chartAt(db, "2026-02-02", "album");
      expect(rows.map((r) => [r.name, r.artist])).toEqual([
        ["Same Name - Band One", "Band One"],
        ["Same Name - Band Two", "Band Two"],
      ]);
    });
  });

  it("keeps the artist name exactly as stored, with unicode, quotes and a dash", async () => {
    const odd = "S\u00f8lv\u00e6n Ma\u00ebl \u2014 \"The 'Quote'\" \u{1F3B5}";
    await insertPlays([play("odd", "2026-02-03T12:00:00Z", { artist_name: odd })]);
    await withDb(async (db) => {
      expect((await chartAt(db, "2026-02-02", "track"))[0]!.artist).toBe(odd);
    });
  });

  it("returns exactly these columns, in this order", async () => {
    await withDb(async (db) => {
      const result = await db.query("select * from public.chart_weekly('2026-02-02'::date, 'track', 25, 1, $1::timestamptz)", [NOW]);
      expect(result.fields.map((f) => f.name)).toEqual([
        "rank",
        "key",
        "name",
        "artist",
        "plays",
        "minutes",
        "last_week_rank",
        "peak_rank",
        "weeks_on_chart",
      ]);
    });
  });
});

describe("chart_weekly: the artist rule when a track key has more than one artist name", () => {
  it("picks the artist with the most counted plays of that key", async () => {
    await insertPlays([
      shared("Alpha", "2026-02-03T12:00:00Z"),
      shared("Beta", "2026-02-03T12:10:00Z"),
      shared("Beta", "2026-02-03T12:20:00Z"),
    ]);
    expect(await artistOf("2026-02-02", SHARED_URI)).toBe("Beta");
  });

  it("breaks a tie by artist name in byte order, so a capital letter comes before a lower case one", async () => {
    await insertPlays([shared("alpha", "2026-02-03T12:00:00Z"), shared("Zed", "2026-02-03T12:10:00Z")]);
    expect(await artistOf("2026-02-02", SHARED_URI)).toBe("Zed");

    await clearPlays();
    await insertPlays([shared("Beta", "2026-02-03T12:00:00Z"), shared("Alpha", "2026-02-03T12:10:00Z")]);
    expect(await artistOf("2026-02-02", SHARED_URI)).toBe("Alpha");
  });

  it("gives the same answer whatever order the plays were stored in", async () => {
    const rows = [
      shared("Alpha", "2026-02-03T12:00:00Z"),
      shared("Beta", "2026-02-03T12:10:00Z"),
      shared("Beta", "2026-02-03T12:20:00Z"),
      shared("Alpha", "2026-02-03T12:30:00Z"),
      shared("Gamma", "2026-02-03T12:40:00Z"),
    ];
    await insertPlays(rows);
    const forward = await artistOf("2026-02-02", SHARED_URI);
    await clearPlays();
    await insertPlays([...rows].reverse());
    expect(await artistOf("2026-02-02", SHARED_URI)).toBe(forward);
    expect(forward).toBe("Alpha");
  });

  it("counts every week up to the week asked for, not only that week", async () => {
    await insertPlays([
      shared("Old Name", "2026-02-03T12:00:00Z"),
      shared("Old Name", "2026-02-03T12:10:00Z"),
      shared("Old Name", "2026-02-03T12:20:00Z"),
      shared("New Name", "2026-02-10T12:00:00Z"),
    ]);
    expect(await artistOf("2026-02-02", SHARED_URI)).toBe("Old Name");
    // One play of the new name in this week, three of the old name before it.
    expect(await artistOf("2026-02-09", SHARED_URI)).toBe("Old Name");
  });

  it("never lets a later week change an earlier week", async () => {
    await insertPlays([
      shared("Early", "2026-02-03T12:00:00Z"),
      ...Array.from({ length: 5 }, (_, i) => shared("Late", `2026-02-10T12:0${i}:00Z`)),
    ]);
    expect(await artistOf("2026-02-02", SHARED_URI)).toBe("Early");
    expect(await artistOf("2026-02-09", SHARED_URI)).toBe("Late");
  });

  it("counts only plays the chart counts: not a play under 30 seconds, not a play inside the delay", async () => {
    await insertPlays([
      shared("Real", "2026-03-03T12:00:00Z"),
      ...Array.from({ length: 4 }, (_, i) => shared("Short", `2026-03-03T13:0${i}:00Z`, { ms_played: 29_999 })),
      // Inside the delay: after Wednesday 2026-03-11 00:00 Eastern.
      ...Array.from({ length: 4 }, (_, i) => shared("Fresh", `2026-03-11T12:0${i}:00Z`)),
    ]);
    expect(await artistOf("2026-03-02", SHARED_URI)).toBe("Real");
    // A play with no ms_played is a poll row, and it counts.
    await insertPlays(
      Array.from({ length: 2 }, (_, i) => shared("Poll", `2026-03-04T12:0${i}:00Z`, { source: "poll", ms_played: null })),
    );
    expect(await artistOf("2026-03-02", SHARED_URI)).toBe("Poll");
  });

  it("breaks a tie after normalising Unicode form (NFKC), so a decomposed accent sorts as the accented letter", async () => {
    // "Ze" plus a combining acute is the same name as "Z\u00e9" once normalised. Raw bytes put it before "Zf",
    // and the normalised form puts it after, so the tie goes to "Zf".
    await insertPlays([shared("Ze\u0301", "2026-02-03T12:00:00Z"), shared("Zf", "2026-02-03T12:10:00Z")]);
    expect(await artistOf("2026-02-02", SHARED_URI)).toBe("Zf");
  });

  it("leaves a play at exactly the end of the week, Monday 00:00 Eastern, to the next week", async () => {
    // Week 2026-02-02 ends at 2026-02-09T05:00:00Z (standard time).
    await insertPlays([
      shared("Early", "2026-02-03T12:00:00Z"),
      shared("Boundary", "2026-02-09T05:00:00Z"),
      shared("Boundary", "2026-02-09T05:01:00Z"),
      shared("Boundary", "2026-02-09T05:02:00Z"),
      shared("Last", "2026-02-09T04:59:59Z"),
    ]);
    await withDb(async (db) => {
      // Early 1 and Last 1 tie, and Boundary is not counted. The tie goes to the name first in byte order.
      expect(await chartAt(db, "2026-02-02")).toEqual([
        { key: SHARED_URI, name: "Shared Song", artist: "Early", plays: 2 },
      ]);
      // The next week counts the three Boundary plays.
      expect((await chartAt(db, "2026-02-09"))[0]).toMatchObject({ artist: "Boundary", plays: 3 });
    });
  });

  it("counts a play at exactly the public cutoff, and not one a millisecond later", async () => {
    // At NOW the cutoff is 2026-03-11T04:00:00Z. Week 2026-03-09 is open.
    await insertPlays([
      shared("Alpha", "2026-03-09T12:00:00Z"),
      shared("Zulu", "2026-03-09T13:00:00Z"),
      shared("Zulu", "2026-03-11T04:00:00.000Z"),
      ...[1, 2, 3, 4, 5].map((ms) => shared("Yankee", `2026-03-11T04:00:00.00${ms}Z`)),
    ]);
    await withDb(async (db) => {
      // Zulu has 2 counted plays. Alpha has 1. Yankee's five are all after the cutoff.
      expect(await chartAt(db, "2026-03-09")).toEqual([
        { key: SHARED_URI, name: "Shared Song", artist: "Zulu", plays: 3 },
      ]);
    });
  });

  it("keeps the week edge on the Eastern clock in a week that holds the spring forward change", async () => {
    // Sunday 2026-03-08 is 23 hours long. Week 2026-03-02 ends at Monday 2026-03-09T04:00:00Z.
    await insertPlays([
      shared("Mid", "2026-03-03T12:00:00Z"),
      shared("Edge", "2026-03-09T03:58:00Z"),
      shared("Edge", "2026-03-09T03:59:59Z"),
      ...[0, 1, 2].map((i) => shared("Monday", `2026-03-09T04:0${i}:00Z`)),
    ]);
    expect(await artistOf("2026-03-02", SHARED_URI)).toBe("Edge");
    expect(await artistOf("2026-03-09", SHARED_URI)).toBe("Monday");
  });

  it("keeps the week edge on the Eastern clock in a week that holds the fall back change", async () => {
    // Sunday 2026-11-01 is 25 hours long. Week 2026-10-26 ends at Monday 2026-11-02T05:00:00Z.
    const now = "2026-11-12T15:00:00Z";
    await insertPlays([
      shared("Mid", "2026-10-27T12:00:00Z"),
      shared("Edge", "2026-11-02T04:58:00Z"),
      shared("Edge", "2026-11-02T04:59:59Z"),
      ...[0, 1, 2].map((i) => shared("Monday", `2026-11-02T05:0${i}:00Z`)),
    ]);
    expect(await artistOf("2026-10-26", SHARED_URI, now)).toBe("Edge");
    expect(await artistOf("2026-11-02", SHARED_URI, now)).toBe("Monday");
  });

  it("does not move the rank, plays or name of the row", async () => {
    await insertPlays([shared("Alpha", "2026-02-03T12:00:00Z"), shared("Beta", "2026-02-03T12:10:00Z")]);
    await withDb(async (db) => {
      const rows = await chartAt(db, "2026-02-02");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ key: SHARED_URI, plays: 2 });
    });
  });
});

describe("the chart functions after the artist column", () => {
  it("leave one chart_weekly in public, with the same privacy settings as before", async () => {
    await withDb(async (db) => {
      const result = await db.query<{ proconfig: string[] | null; secdef: boolean; volatile: string }>(
        `select p.proconfig, p.prosecdef as secdef, p.provolatile as volatile
           from pg_proc p
          where p.pronamespace = 'public'::regnamespace and p.proname = 'chart_weekly'`,
      );
      expect(result.rows).toHaveLength(1);
      const row = result.rows[0]!;
      expect(row.proconfig).toEqual(expect.arrayContaining(["statement_timeout=5s", 'search_path=""']));
      expect(row.secdef).toBe(false);
      expect(row.volatile).toBe("s");
    });
  });

  it("is executable by the service role only", async () => {
    await withDb(async (db) => {
      const result = await db.query<{ role: string; allowed: boolean }>(
        `select r.role, has_function_privilege(r.role, p.oid, 'EXECUTE') as allowed
           from pg_proc p
          cross join (values ('anon'), ('authenticated'), ('service_role')) as r(role)
          where p.pronamespace = 'public'::regnamespace and p.proname = 'chart_weekly'
          order by r.role`,
      );
      expect(result.rows).toEqual([
        { role: "anon", allowed: false },
        { role: "authenticated", allowed: false },
        { role: "service_role", allowed: true },
      ]);
    });
  });

  it("gives a delay under one day an error, as before", async () => {
    await withDb(async (db) => {
      await expect(
        db.query("select * from public.chart_weekly('2026-02-02'::date, 'track', 25, 0, $1::timestamptz)", [NOW]),
      ).rejects.toMatchObject({ message: expect.stringContaining("delay") });
    });
  });
});

describe("chart_bounds: the weeks the answer names", () => {
  it("gives null for the first and latest week when the table holds no play", async () => {
    await withDb(async (db) => {
      const result = await db.query(
        "select first_week, latest_week from public.chart_bounds('track', 1, $1::timestamptz)",
        [NOW],
      );
      expect(result.rows).toEqual([{ first_week: null, latest_week: null }]);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Over HTTP
// ---------------------------------------------------------------------------------------------

async function getChart(query = "") {
  return fetch(`${env.sites.healthy}/api/charts/weekly${query ? `?${query}` : ""}`);
}

async function chart(query: string): Promise<Chart> {
  const res = await getChart(query);
  expect(res.status).toBe(200);
  return (await res.json()) as Chart;
}

describe("GET /api/charts/weekly: the artist on each row", () => {
  async function load() {
    await insertPlays([
      ...plays("t1", 2, "2026-02-03T12:00:00Z", { artist_name: "Artist One", album_name: "Album One" }),
      play("t2", "2026-02-03T12:30:00Z", { artist_name: "Artist Two", album_name: "Album Two" }),
    ]);
  }

  it("gives the artist name on a track row", async () => {
    await load();
    const c = await chart("week=2026-02-02&kind=track");

    expect(c.rows.map((r) => [r.name, r.artist])).toEqual([
      ["Track t1", "Artist One"],
      ["Track t2", "Artist Two"],
    ]);
  });

  it("gives the artist name on an album row", async () => {
    await load();
    const c = await chart("week=2026-02-02&kind=album");

    expect(c.rows.map((r) => [r.name, r.artist])).toEqual([
      ["Album One - Artist One", "Artist One"],
      ["Album Two - Artist Two", "Artist Two"],
    ]);
  });

  it("gives null on an artist row, and still sends the field", async () => {
    await load();
    const text = await (await getChart("week=2026-02-02&kind=artist")).text();
    const c = JSON.parse(text) as Chart;

    expect(c.rows.map((r) => [r.name, r.artist])).toEqual([
      ["Artist One", null],
      ["Artist Two", null],
    ]);
    expect(text).toContain('"artist":null');
  });

  it("resolves a track played under two artist names by the most played, then the first name in byte order", async () => {
    await insertPlays([
      shared("Beta", "2026-02-03T12:00:00Z"),
      shared("Alpha", "2026-02-03T12:10:00Z"),
      shared("Beta", "2026-02-03T12:20:00Z"),
      shared("Zed", "2026-02-10T12:00:00Z"),
      shared("alpha", "2026-02-10T12:10:00Z"),
    ]);

    const first = await chart("week=2026-02-02");
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({ plays: 3, artist: "Beta" });
    // Up to this week: Beta 2, Alpha 1, Zed 1, alpha 1.
    expect((await chart("week=2026-02-09")).rows[0]).toMatchObject({ plays: 2, artist: "Beta" });
  });

  it("does not let a play inside the public delay, or one under 30 seconds, choose the artist", async () => {
    await insertPlays([
      shared("Visible", "2026-02-03T12:00:00Z"),
      ...Array.from({ length: 5 }, (_, i) => shared("Hidden", new Date(Date.now() - (2 + i) * 60_000).toISOString())),
      ...Array.from({ length: 5 }, (_, i) => shared("Short", `2026-02-03T13:0${i}:00Z`, { ms_played: 5_000 })),
    ]);

    expect((await chart("week=2026-02-02")).rows[0]).toMatchObject({ artist: "Visible", plays: 1 });
    const text = await (await getChart("week=2026-02-02")).text();
    expect(text).not.toContain("Hidden");
    expect(text).not.toContain("Short");
  });

  it("does not let the new field show a play the old shape hid", async () => {
    // The only play of this artist is under 30 seconds, so the track has no row at all.
    await insertPlays([
      play("quiet", "2026-02-03T12:00:00Z", { artist_name: "Secret Artist", ms_played: 1_000 }),
      play("loud", "2026-02-03T12:10:00Z"),
    ]);
    const text = await (await getChart("week=2026-02-02")).text();

    expect(text).not.toContain("Secret Artist");
    expect(text).not.toContain("quiet");
  });
});

describe("GET /api/charts/weekly: first_week and latest_week", () => {
  async function loadHistory() {
    await insertPlays([
      play("early", "2026-02-04T12:00:00Z"),
      play("mid", "2026-02-18T12:00:00Z"),
      play("late", "2026-03-04T12:00:00Z"),
    ]);
  }

  it("names the first and latest week next to the week asked for", async () => {
    await loadHistory();
    const c = await chart("week=2026-02-16");

    expect(c.week_start).toBe("2026-02-16");
    expect(c.first_week).toBe("2026-02-02");
    expect(c.latest_week).toBe("2026-03-02");
  });

  it("names them on the default week too, which is the latest week", async () => {
    await loadHistory();
    const c = await chart("");

    expect(c.week_start).toBe("2026-03-02");
    expect(c.first_week).toBe("2026-02-02");
    expect(c.latest_week).toBe("2026-03-02");
  });

  it("sends both as YYYY-MM-DD Mondays, after the week and before the kind", async () => {
    await loadHistory();
    const body = (await chart("")) as Chart;

    expect(Object.keys(body)).toEqual(["week_start", "first_week", "latest_week", "kind", "rows"]);
    for (const value of [body.first_week, body.latest_week]) {
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${value}T00:00:00Z`).getUTCDay()).toBe(1);
    }
  });

  it("gives null for both, with the same shape as before, when no play is stored", async () => {
    const res = await getChart("");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      week_start: null,
      first_week: null,
      latest_week: null,
      kind: "track",
      rows: [],
      status: "no_data",
    });
  });

  it("gives the range for the kind asked for, so an album chart skips plays with no album", async () => {
    await insertPlays([
      play("single", "2026-01-06T12:00:00Z", { album_name: null }),
      play("album", "2026-02-18T12:00:00Z"),
      play("single2", "2026-03-04T12:00:00Z", { album_name: null }),
    ]);

    const album = await chart("kind=album");
    expect([album.first_week, album.latest_week]).toEqual(["2026-02-16", "2026-02-16"]);
    const track = await chart("kind=track");
    expect([track.first_week, track.latest_week]).toEqual(["2026-01-05", "2026-03-02"]);
  });

  it("does not let a play inside the delay, or one under 30 seconds, move either week", async () => {
    await insertPlays([
      play("short", "2026-01-06T12:00:00Z", { ms_played: 29_999 }),
      play("real", "2026-02-18T12:00:00Z"),
      play("fresh", new Date(Date.now() - 3_600_000).toISOString()),
    ]);
    const c = await chart("");

    expect(c.first_week).toBe("2026-02-16");
    expect(c.latest_week).toBe("2026-02-16");
  });

  it("keeps the 400 for a week outside the range, with no range in the body", async () => {
    await loadHistory();
    const res = await getChart("week=2026-01-26");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ status: "bad_request" });
  });

  it("keeps the same cache headers", async () => {
    await loadHistory();

    expect((await getChart("")).headers.get("cache-control")).toBe("public, s-maxage=300, stale-while-revalidate=600");
    await clearPlays();
    expect((await getChart("")).headers.get("cache-control")).toBe("public, s-maxage=300, stale-while-revalidate=600");
  });
});
