import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  albumKey,
  clearPlays,
  insertPlays,
  play,
  plays,
  withDb,
  type Chart,
  type Play,
} from "./support/chart-data";
import { readSiteLog, testEnv, waitForSiteLog, type SiteName } from "./support/env";

/**
 * The HTTP boundary of the site against the local database. Every row is synthetic.
 * Dates in fixtures are written out, never worked out by the code under test.
 * Only the plays test files commit rows to plays, and the files run one at a time.
 */
const env = testEnv();

const CACHEABLE = "public, s-maxage=300, stale-while-revalidate=600";

async function getChart(query = "", site: SiteName = "healthy") {
  return fetch(`${env.sites[site]}/api/charts/weekly${query ? `?${query}` : ""}`);
}

async function chart(query: string): Promise<Chart> {
  const res = await getChart(query);
  expect(res.status).toBe(200);
  return (await res.json()) as Chart;
}

/**
 * A Monday in New York time, `weeksFromNow` chart weeks from the current one.
 * The database reads its own clock and finds the Monday by day-of-week arithmetic, which is a
 * different route from the SQL function's week rule. Only the edge tests need it.
 */
async function newYorkMonday(weeksFromNow: number): Promise<string> {
  return withDb(async (db) => {
    const result = await db.query<{ monday: string }>(
      `select to_char(d - (extract(isodow from d)::int - 1) + 7 * $1::int, 'YYYY-MM-DD') as monday
         from (select (now() at time zone 'America/New_York')::date as d) as today`,
      [weeksFromNow],
    );
    return result.rows[0]!.monday;
  });
}

function names(c: Chart): string[] {
  return c.rows.map((r) => r.name);
}

beforeAll(clearPlays);
beforeEach(clearPlays);
afterAll(clearPlays);

describe("GET /api/charts/weekly: ranks, last week, peak and weeks on chart", () => {
  // Three chart weeks, Monday 2026-02-02, 2026-02-09 and 2026-02-16. All plays at noon UTC.
  //   week 1: A 3 plays, B 2, C 1          -> A1 B2 C3
  //   week 2: B 3 plays, A 2, D 1          -> B1 A2 D3  (C is absent)
  //   week 3: C 3 plays, A 2, B 1          -> C1 A2 B3  (D is absent)
  async function loadThreeWeeks() {
    await insertPlays([
      ...plays("a", 3, "2026-02-03T12:00:00Z"),
      ...plays("b", 2, "2026-02-03T13:00:00Z"),
      ...plays("c", 1, "2026-02-03T14:00:00Z"),
      ...plays("b", 3, "2026-02-10T12:00:00Z"),
      ...plays("a", 2, "2026-02-10T13:00:00Z"),
      ...plays("d", 1, "2026-02-10T14:00:00Z"),
      ...plays("c", 3, "2026-02-17T12:00:00Z"),
      ...plays("a", 2, "2026-02-17T13:00:00Z"),
      ...plays("b", 1, "2026-02-17T14:00:00Z"),
    ]);
  }

  it("returns the first week with no last week and a peak of this week", async () => {
    await loadThreeWeeks();
    const c = await chart("week=2026-02-02");

    expect(c.week_start).toBe("2026-02-02");
    expect(c.kind).toBe("track");
    // Every play is 200,000 ms: 3 plays = 10 minutes, 2 plays = 6.67 (shown 7), 1 play = 3.33 (shown 3).
    expect(c.rows).toEqual([
      { rank: 1, key: "spotify:track:synthetic-a", name: "Track a", artist: "Artist a", plays: 3, minutes: 10, last_week_rank: null, peak_rank: 1, weeks_on_chart: 1 },
      { rank: 2, key: "spotify:track:synthetic-b", name: "Track b", artist: "Artist b", plays: 2, minutes: 7, last_week_rank: null, peak_rank: 2, weeks_on_chart: 1 },
      { rank: 3, key: "spotify:track:synthetic-c", name: "Track c", artist: "Artist c", plays: 1, minutes: 3, last_week_rank: null, peak_rank: 3, weeks_on_chart: 1 },
    ]);
  });

  it("returns last week's rank, and a peak and weeks on chart across earlier weeks", async () => {
    await loadThreeWeeks();
    const c = await chart("week=2026-02-09");

    expect(c.rows.map((r) => [r.name, r.rank, r.last_week_rank, r.peak_rank, r.weeks_on_chart])).toEqual([
      ["Track b", 1, 2, 1, 2],
      ["Track a", 2, 1, 1, 2],
      ["Track d", 3, null, 3, 1],
    ]);
  });

  it("gives null for last week when the item skipped the week, and counts weeks it appeared", async () => {
    await loadThreeWeeks();
    const c = await chart("week=2026-02-16");

    expect(c.rows.map((r) => [r.name, r.rank, r.last_week_rank, r.peak_rank, r.weeks_on_chart])).toEqual([
      ["Track c", 1, null, 1, 2],
      ["Track a", 2, 2, 1, 3],
      ["Track b", 3, 1, 1, 3],
    ]);
  });

  it("never counts a later week in the peak or the weeks on chart", async () => {
    await loadThreeWeeks();
    const c = await chart("week=2026-02-02");
    const b = c.rows.find((r) => r.name === "Track b");

    expect(b).toMatchObject({ peak_rank: 2, weeks_on_chart: 1 });
  });

  it("shows the whole week, not a page, in last week's rank when the limit cuts the list", async () => {
    await loadThreeWeeks();
    const c = await chart("week=2026-02-16&limit=1");

    expect(c.rows).toHaveLength(1);
    expect(c.rows[0]).toMatchObject({ name: "Track c", rank: 1 });
    const next = await chart("week=2026-02-16&limit=2");
    expect(next.rows[1]).toMatchObject({ name: "Track a", last_week_rank: 2, peak_rank: 1, weeks_on_chart: 3 });
  });

  it("answers an empty week inside the stored range with an empty list", async () => {
    await loadThreeWeeks();
    const c = await chart("week=2026-03-02");

    expect(c).toEqual({ week_start: "2026-03-02", first_week: "2026-02-02", latest_week: "2026-02-16", kind: "track", rows: [] });
  });
});

describe("GET /api/charts/weekly: the default week", () => {
  async function loadThreeWeeks() {
    await insertPlays([
      ...plays("a", 3, "2026-02-03T12:00:00Z"),
      ...plays("c", 3, "2026-02-17T12:00:00Z"),
      ...plays("a", 2, "2026-02-17T13:00:00Z"),
    ]);
  }

  it("shows the latest week that has plays", async () => {
    await loadThreeWeeks();
    const c = await chart("");

    expect(c.week_start).toBe("2026-02-16");
    expect(names(c)).toEqual(["Track c", "Track a"]);
  });

  it("answers no_data, with no week, when no play is stored", async () => {
    const res = await getChart("");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ week_start: null, first_week: null, latest_week: null, kind: "track", rows: [], status: "no_data" });
  });

  it("keeps the kind in a no_data answer", async () => {
    const res = await getChart("kind=artist");

    expect(await res.json()).toEqual({ week_start: null, first_week: null, latest_week: null, kind: "artist", rows: [], status: "no_data" });
  });

  it("answers no_data when every stored play is under 30 seconds", async () => {
    await insertPlays([play("short", "2026-02-03T12:00:00Z", { ms_played: 29_999 })]);

    expect(await (await getChart("")).json()).toEqual({ week_start: null, first_week: null, latest_week: null, kind: "track", rows: [], status: "no_data" });
  });

  it("answers no_data when every stored play is inside the public delay", async () => {
    await insertPlays([play("fresh", new Date(Date.now() - 3_600_000).toISOString())]);

    expect(await (await getChart("")).json()).toEqual({ week_start: null, first_week: null, latest_week: null, kind: "track", rows: [], status: "no_data" });
  });

  it("skips a newer week that holds only plays under 30 seconds", async () => {
    await insertPlays([
      play("real", "2026-02-03T12:00:00Z"),
      play("short", "2026-02-17T12:00:00Z", { ms_played: 5_000 }),
    ]);
    const c = await chart("");

    expect(c.week_start).toBe("2026-02-02");
    expect(names(c)).toEqual(["Track real"]);
  });

  it("counts a poll row with no ms_played when it picks the latest week", async () => {
    await insertPlays([
      play("real", "2026-02-03T12:00:00Z"),
      play("poll", "2026-02-17T12:00:00Z", { source: "poll", ms_played: null }),
    ]);

    expect((await chart("")).week_start).toBe("2026-02-16");
  });

  it("picks the latest week that has an album when the kind is album", async () => {
    await insertPlays([
      play("album", "2026-02-03T12:00:00Z"),
      play("single", "2026-02-17T12:00:00Z", { album_name: null }),
    ]);

    expect((await chart("kind=album")).week_start).toBe("2026-02-02");
    expect((await chart("kind=track")).week_start).toBe("2026-02-16");
  });

  it("answers no_data for albums when no stored play has an album", async () => {
    await insertPlays([play("single", "2026-02-03T12:00:00Z", { album_name: null })]);

    expect(await (await getChart("kind=album")).json()).toEqual({
      week_start: null,
      first_week: null,
      latest_week: null,
      kind: "album",
      rows: [],
      status: "no_data",
    });
    expect((await chart("kind=track")).week_start).toBe("2026-02-02");
  });

  it("never picks a week that holds only recent plays", async () => {
    await insertPlays([play("older", "2026-02-03T12:00:00Z"), play("fresh", new Date(Date.now() - 7_200_000).toISOString())]);
    const c = await chart("");

    expect(c.week_start).toBe("2026-02-02");
    expect(names(c)).toEqual(["Track older"]);
  });
});

describe("GET /api/charts/weekly: caching", () => {
  it("lets a shared cache keep a chart for five minutes", async () => {
    await insertPlays([play("a", "2026-02-03T12:00:00Z")]);
    const res = await getChart("week=2026-02-02");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(CACHEABLE);
  });

  it("caches the default week and a no_data answer the same way", async () => {
    expect((await getChart("")).headers.get("cache-control")).toBe(CACHEABLE);
    await insertPlays([play("a", "2026-02-03T12:00:00Z")]);
    expect((await getChart("")).headers.get("cache-control")).toBe(CACHEABLE);
  });

  it("never caches a bad request", async () => {
    const res = await getChart("week=abc");

    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("never caches a week out of range", async () => {
    await insertPlays([play("a", "2026-02-03T12:00:00Z")]);
    const res = await getChart("week=2026-01-26");

    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /api/charts/weekly: the range of weeks", () => {
  beforeEach(async () => {
    await insertPlays([play("a", "2026-02-04T12:00:00Z")]);
  });

  it("accepts the Monday of the first stored play, and not the Monday before", async () => {
    expect((await getChart("week=2026-02-02")).status).toBe(200);

    const before = await getChart("week=2026-01-26");
    expect(before.status).toBe(400);
    expect(await before.json()).toEqual({ status: "bad_request" });
  });

  it("accepts the current New York Monday, and not the next one", async () => {
    expect((await getChart(`week=${await newYorkMonday(0)}`)).status).toBe(200);

    const next = await getChart(`week=${await newYorkMonday(1)}`);
    expect(next.status).toBe(400);
    expect(await next.json()).toEqual({ status: "bad_request" });
  });

  it("refuses a Monday far in the future", async () => {
    expect((await getChart("week=2099-01-05")).status).toBe(400);
  });

  it("does not let a play inside the delay set the first week, so no explicit week is open", async () => {
    await clearPlays();
    await insertPlays([play("fresh", new Date(Date.now() - 3_600_000).toISOString())]);

    expect((await getChart(`week=${await newYorkMonday(0)}`)).status).toBe(400);
    expect((await getChart(`week=${await newYorkMonday(-1)}`)).status).toBe(400);
  });

  it("does not let a play under 30 seconds, older than every visible play, move the lower bound", async () => {
    await clearPlays();
    await insertPlays([
      play("short", "2026-01-06T12:00:00Z", { ms_played: 29_999 }),
      play("visible", "2026-02-04T12:00:00Z"),
    ]);

    // The Monday of the short play is 2026-01-05. It is refused the same as any week before the first.
    expect((await getChart("week=2026-01-05")).status).toBe(400);
    expect((await getChart("week=2026-01-26")).status).toBe(400);
    expect((await getChart("week=2026-02-02")).status).toBe(200);
  });

  it("does not let an album-less play, older than every album play, move the lower bound of an album chart", async () => {
    await clearPlays();
    await insertPlays([
      play("single", "2026-01-06T12:00:00Z", { album_name: null }),
      play("album", "2026-02-04T12:00:00Z"),
    ]);

    expect((await getChart("kind=album&week=2026-01-05")).status).toBe(400);
    expect((await getChart("kind=album&week=2026-02-02")).status).toBe(200);
    // For tracks the same play counts, so its week is open.
    expect((await getChart("kind=track&week=2026-01-05")).status).toBe(200);
  });

  it("refuses every explicit week when no play is stored", async () => {
    await clearPlays();

    expect((await getChart("week=2026-02-02")).status).toBe(400);
  });
});

describe("GET /api/charts/weekly: the Eastern chart week", () => {
  // Each pair is the last second of a chart week and the first second of the next.
  it.each<[string, string, string, string, string]>([
    ["standard time", "2026-01-19T04:59:59Z", "2026-01-19T05:00:00Z", "2026-01-12", "2026-01-19"],
    ["daylight time", "2026-06-15T03:59:59Z", "2026-06-15T04:00:00Z", "2026-06-08", "2026-06-15"],
    ["the week ending at spring forward", "2026-03-09T03:59:59Z", "2026-03-09T04:00:00Z", "2026-03-02", "2026-03-09"],
    ["the week ending at fall back", "2026-11-02T04:59:59Z", "2026-11-02T05:00:00Z", "2026-10-26", "2026-11-02"],
  ])("puts Sunday night and Monday morning in the right weeks, in %s", async (_label, sunday, monday, weekBefore, weekAfter) => {
    await insertPlays([play("sunday", sunday), play("monday", monday)]);

    expect(names(await chart(`week=${weekBefore}`))).toEqual(["Track sunday"]);
    expect(names(await chart(`week=${weekAfter}`))).toEqual(["Track monday"]);
  });

  it("puts a Sunday 23:30 Eastern play in the week that ends, in daylight time", async () => {
    // Sunday 2026-06-14 23:30 EDT is Monday 03:30 UTC. A UTC week would move it.
    await insertPlays([play("late", "2026-06-15T03:30:00Z")]);

    expect(names(await chart("week=2026-06-08"))).toEqual(["Track late"]);
    expect(await chart("week=2026-06-15")).toMatchObject({ rows: [] });
  });

  it("puts a Sunday 23:30 Eastern play in the week that ends, in standard time", async () => {
    // Sunday 2026-01-18 23:30 EST is Monday 04:30 UTC. A fixed daylight offset would move it.
    await insertPlays([play("late", "2026-01-19T04:30:00Z")]);

    expect(names(await chart("week=2026-01-12"))).toEqual(["Track late"]);
    expect(await chart("week=2026-01-19")).toMatchObject({ rows: [] });
  });

  it("counts every day of a week that holds a clock change", async () => {
    // Monday 2026-10-26 to Sunday 2026-11-01 holds the fall back of 2026-11-01.
    await insertPlays([play("mon", "2026-10-26T04:00:00Z"), play("sun", "2026-11-02T04:59:59Z")]);

    expect(names(await chart("week=2026-10-26"))).toEqual(["Track mon", "Track sun"]);
  });
});

describe("GET /api/charts/weekly: ranking rules", () => {
  const week = "week=2026-02-02";

  it("ranks by play count first, even when a track with fewer plays has more minutes", async () => {
    await insertPlays([
      ...plays("few", 1, "2026-02-03T12:00:00Z", { ms_played: 900_000 }),
      ...plays("many", 2, "2026-02-03T13:00:00Z", { ms_played: 31_000 }),
    ]);

    expect(names(await chart(week))).toEqual(["Track many", "Track few"]);
  });

  it("breaks a tie in plays by minutes played", async () => {
    await insertPlays([
      ...plays("aaa", 2, "2026-02-03T12:00:00Z", { ms_played: 60_000 }),
      ...plays("zzz", 2, "2026-02-03T13:00:00Z", { ms_played: 120_000 }),
    ]);
    const c = await chart(week);

    expect(c.rows.map((r) => [r.name, r.plays, r.minutes, r.rank])).toEqual([
      ["Track zzz", 2, 4, 1],
      ["Track aaa", 2, 2, 2],
    ]);
  });

  it("ranks by the exact minutes, so two items that show the same whole minutes still have an order", async () => {
    // Both show 2 minutes (122,000 and 124,000 ms). The one that sorts last by name has more time.
    await insertPlays([
      ...plays("aa", 2, "2026-02-03T12:00:00Z", { ms_played: 61_000 }),
      ...plays("zz", 2, "2026-02-03T13:00:00Z", { ms_played: 62_000 }),
    ]);
    const c = await chart(week);

    expect(c.rows.map((r) => [r.name, r.minutes])).toEqual([
      ["Track zz", 2],
      ["Track aa", 2],
    ]);
  });

  it("shows whole minutes, so no row gives away the length of one play", async () => {
    await insertPlays([play("solo", "2026-02-03T12:00:00Z", { ms_played: 187_654 })]);
    const res = await getChart(week);
    const text = await res.text();
    const row = (JSON.parse(text) as Chart).rows[0]!;

    expect(row.minutes).toBe(3);
    expect(Number.isInteger(row.minutes)).toBe(true);
    expect(/187|3\.1/.test(text)).toBe(false);
  });

  it("rounds minutes to the nearest whole minute", async () => {
    await insertPlays([
      play("down", "2026-02-03T12:00:00Z", { ms_played: 89_999 }),
      play("up", "2026-02-03T13:00:00Z", { ms_played: 90_000 }),
    ]);
    const c = await chart(week);

    expect(Object.fromEntries(c.rows.map((r) => [r.name, r.minutes]))).toEqual({
      "Track down": 1,
      "Track up": 2,
    });
  });

  it("breaks a tie in plays and minutes by name, ignoring case, then by exact name, then by key", async () => {
    // One play each, all the same length, so every item ties on plays and minutes.
    // Expected order, written by hand: Alpha and alpha tie on lower case, and "Alpha" sorts first;
    // the two "echo" tracks tie on name too, so the key (the track URI) decides.
    const tracks: [string, string][] = [
      ["spotify:track:synthetic-6", "echo"],
      ["spotify:track:synthetic-1", "Alpha"],
      ["spotify:track:synthetic-2", "alpha"],
      ["spotify:track:synthetic-3", "Bravo"],
      ["spotify:track:synthetic-4", "charlie"],
      ["spotify:track:synthetic-5", "Delta"],
      ["spotify:track:synthetic-7", "echo"],
    ];
    const expected = [
      "spotify:track:synthetic-1",
      "spotify:track:synthetic-2",
      "spotify:track:synthetic-3",
      "spotify:track:synthetic-4",
      "spotify:track:synthetic-5",
      "spotify:track:synthetic-6",
      "spotify:track:synthetic-7",
    ];
    const rows = tracks.map(([uri, name], i) =>
      play("tie", `2026-02-03T12:0${i}:00Z`, { track_uri: uri, track_name: name }),
    );

    // The same rows go in in five different orders. The ranks must not follow insert order.
    const orders = [
      [0, 1, 2, 3, 4, 5, 6],
      [6, 5, 4, 3, 2, 1, 0],
      [3, 0, 6, 1, 5, 2, 4],
      [2, 4, 0, 6, 1, 3, 5],
      [5, 6, 1, 4, 0, 2, 3],
    ];
    for (const order of orders) {
      await clearPlays();
      await insertPlays(order.map((i) => rows[i]!));
      const c = await chart(week);

      expect(c.rows.map((r) => r.key), `insert order ${order.join("")}`).toEqual(expected);
      expect(c.rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    }
  });

  it("sums minutes over rows that have ms_played only, and counts a poll row with none", async () => {
    // Both tracks have two plays. The poll track holds 1 minute of known play time,
    // the export track 1.5 minutes (shown 2). A null counted as a full play would change this.
    await insertPlays([
      play("poll", "2026-02-03T12:00:00Z", { source: "poll", ms_played: null }),
      play("poll", "2026-02-03T12:05:00Z", { source: "poll", ms_played: 60_000 }),
      ...plays("export", 2, "2026-02-03T13:00:00Z", { ms_played: 45_000 }),
    ]);
    const c = await chart(week);

    expect(c.rows.map((r) => [r.name, r.plays, r.minutes])).toEqual([
      ["Track export", 2, 2],
      ["Track poll", 2, 1],
    ]);
  });

  it("counts a track with only poll rows with no ms_played, at zero minutes", async () => {
    await insertPlays(plays("onlypoll", 3, "2026-02-03T12:00:00Z", { source: "poll", ms_played: null }));

    expect((await chart(week)).rows).toEqual([
      { rank: 1, key: "spotify:track:synthetic-onlypoll", name: "Track onlypoll", artist: "Artist onlypoll", plays: 3, minutes: 0, last_week_rank: null, peak_rank: 1, weeks_on_chart: 1 },
    ]);
  });

  it("does not count plays under 30 seconds, but counts exactly 30 seconds", async () => {
    await insertPlays([
      play("short", "2026-02-03T12:00:00Z", { ms_played: 29_999 }),
      play("short", "2026-02-03T12:05:00Z", { ms_played: 0 }),
      play("edge", "2026-02-03T13:00:00Z", { ms_played: 30_000 }),
      play("edge", "2026-02-03T13:05:00Z", { ms_played: 29_999 }),
    ]);
    const c = await chart(week);

    expect(c.rows.map((r) => [r.name, r.plays, r.minutes])).toEqual([["Track edge", 1, 1]]);
  });

  it("does not let short plays lift a peak, a rank, a play count or a weeks on chart", async () => {
    // Week 1: Y 2 plays, X 1 play -> X is rank 2.
    // Week 2: Y 2 plays, X 1 play and 3 short plays. Counted, X would have 4 plays and rank 1.
    // Week 3: X has 5 short plays and nothing else, so it is not on that chart at all.
    await insertPlays([
      ...plays("y", 2, "2026-02-03T12:00:00Z"),
      play("x", "2026-02-03T13:00:00Z"),
      ...plays("y", 2, "2026-02-10T12:00:00Z"),
      play("x", "2026-02-10T13:00:00Z"),
      ...plays("x", 3, "2026-02-10T14:00:00Z", { ms_played: 10_000 }),
      ...plays("x", 5, "2026-02-17T12:00:00Z", { ms_played: 10_000 }),
      ...plays("y", 1, "2026-02-17T13:00:00Z"),
    ]);
    const week2 = await chart("week=2026-02-09");
    const x2 = week2.rows.find((r) => r.name === "Track x");

    expect(x2).toMatchObject({ plays: 1, rank: 2, last_week_rank: 2, peak_rank: 2, weeks_on_chart: 2 });
    expect(week2.rows[0]).toMatchObject({ name: "Track y", plays: 2, rank: 1 });
    expect(names(await chart("week=2026-02-16"))).toEqual(["Track y"]);
  });
});

describe("GET /api/charts/weekly: kind", () => {
  async function loadKinds() {
    await insertPlays([
      // One artist on two albums, and two artists who share an album name.
      play("t1", "2026-02-03T12:00:00Z", { artist_name: "Artist One", album_name: "Album One" }),
      play("t2", "2026-02-03T12:10:00Z", { artist_name: "Artist One", album_name: "Album One" }),
      play("t3", "2026-02-03T12:20:00Z", { artist_name: "Artist One", album_name: "Album Two" }),
      play("t4", "2026-02-03T12:30:00Z", { artist_name: "Artist Two", album_name: "Album One" }),
      play("t5", "2026-02-03T12:40:00Z", { artist_name: "Artist Two", album_name: null }),
    ]);
  }

  it("defaults to tracks, keyed by the track URI", async () => {
    await loadKinds();
    const c = await chart("week=2026-02-02");

    expect(c.kind).toBe("track");
    expect(c.rows.map((r) => r.key).sort()).toEqual([1, 2, 3, 4, 5].map((n) => `spotify:track:synthetic-t${n}`));
  });

  it("groups by artist, keyed by the artist name", async () => {
    await loadKinds();
    const c = await chart("week=2026-02-02&kind=artist");

    expect(c.kind).toBe("artist");
    expect(c.rows.map((r) => [r.key, r.name, r.plays])).toEqual([
      ["Artist One", "Artist One", 3],
      ["Artist Two", "Artist Two", 2],
    ]);
  });

  it("groups by album and artist, shows Album - Artist, and keeps two artists with one album name apart", async () => {
    await loadKinds();
    const c = await chart("week=2026-02-02&kind=album");

    expect(c.kind).toBe("album");
    expect(c.rows.map((r) => [r.name, r.plays])).toEqual([
      ["Album One - Artist One", 2],
      ["Album One - Artist Two", 1],
      ["Album Two - Artist One", 1],
    ]);
    expect(c.rows.map((r) => r.key)).toEqual([
      albumKey("Album One", "Artist One"),
      albumKey("Album One", "Artist Two"),
      albumKey("Album Two", "Artist One"),
    ]);
  });

  it("gives two albums whose joined names read alike different keys", async () => {
    // "A - B" by "C" and "A" by "B - C" both display as "A - B - C". They are two albums.
    await insertPlays([
      play("one", "2026-02-03T12:00:00Z", { album_name: "A - B", artist_name: "C" }),
      play("two", "2026-02-03T12:10:00Z", { album_name: "A", artist_name: "B - C" }),
      play("three", "2026-02-03T12:20:00Z", { album_name: "A\u001f", artist_name: "B" }),
      play("four", "2026-02-03T12:30:00Z", { album_name: "A", artist_name: "\u001fB" }),
    ]);
    const c = await chart("week=2026-02-02&kind=album");

    expect(c.rows).toHaveLength(4);
    expect(new Set(c.rows.map((r) => r.key)).size).toBe(4);
    expect(c.rows.every((r) => r.plays === 1)).toBe(true);
  });

  it("leaves plays with no album out of an album chart", async () => {
    await loadKinds();
    const c = await chart("week=2026-02-02&kind=album");

    expect(c.rows.reduce((sum, r) => sum + r.plays, 0)).toBe(4);
  });

  it("ranks artists with last week, peak and weeks on chart", async () => {
    await insertPlays([
      ...plays("p", 2, "2026-02-03T12:00:00Z", { artist_name: "Shared" }),
      ...plays("q", 1, "2026-02-03T13:00:00Z", { artist_name: "Other" }),
      ...plays("r", 3, "2026-02-10T12:00:00Z", { artist_name: "Other" }),
    ]);
    const c = await chart("week=2026-02-09&kind=artist");

    expect(c.rows).toEqual([
      { rank: 1, key: "Other", name: "Other", artist: null, plays: 3, minutes: 10, last_week_rank: 2, peak_rank: 1, weeks_on_chart: 2 },
    ]);
  });
});

describe("GET /api/charts/weekly: limit", () => {
  async function loadMany(n: number) {
    // Every item has one play of the same length, so the name fixes the order: Track 001 first.
    const rows: Play[] = [];
    for (let i = 1; i <= n; i++) {
      const id = String(i).padStart(3, "0");
      rows.push(...plays(id, 1, `2026-02-03T${String(i % 24).padStart(2, "0")}:${String(Math.floor(i / 24)).padStart(2, "0")}:00Z`, {}));
    }
    await insertPlays(rows);
  }

  it("returns 25 rows by default, 100 at most, and as many as asked below that", async () => {
    await loadMany(120);

    expect((await chart("week=2026-02-02")).rows).toHaveLength(25);
    expect((await chart("week=2026-02-02&limit=100")).rows).toHaveLength(100);
    expect((await chart("week=2026-02-02&limit=3")).rows).toHaveLength(3);
    expect((await chart("week=2026-02-02&limit=1")).rows).toHaveLength(1);
  });

  it("numbers ranks from 1 with no gap", async () => {
    await loadMany(30);
    const c = await chart("week=2026-02-02&limit=30");

    expect(c.rows.map((r) => r.rank)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });
});

describe("GET /api/charts/weekly: the public delay, over HTTP", () => {
  // The exact snap to Eastern midnight is tested in charts-function.test.ts with a fixed clock.
  // Here the site reads the real clock, so only plays that are certainly old or certainly new are used:
  // the cutoff is always between 24 and 48 hours before now.
  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

  it("never shows a play newer than 24 hours, and counts the ones older than 72 hours", async () => {
    await insertPlays([
      play("old", ago(80)),
      play("old", ago(73)),
      play("fresh", ago(23)),
      play("fresh", ago(1)),
    ]);
    const c = await chart("");

    expect(c.rows.map((r) => [r.name, r.plays])).toEqual([["Track old", 2]]);
  });

  it("hides a recent play from a named week too", async () => {
    // The older play is two weeks back, so the current week is inside the stored range.
    await insertPlays([play("old", ago(24 * 14)), play("fresh", ago(2))]);
    const c = await chart(`week=${await newYorkMonday(0)}`);

    expect(c.rows).toEqual([]);
  });
});

describe("GET /api/charts/weekly: bad input", () => {
  it.each([
    ["a week that is not a date", "week=abc"],
    ["an empty week", "week="],
    ["a date that does not exist", "week=2026-02-30"],
    ["a Tuesday", "week=2026-02-03"],
    ["a Sunday", "week=2026-02-08"],
    ["a timestamp", "week=2026-02-02T00:00:00Z"],
    ["a date without dashes", "week=20260202"],
    ["a date with a short month", "week=2026-2-02"],
    ["two weeks", "week=2026-02-02&week=2026-02-09"],
    ["a kind that is not allowed", "kind=song"],
    ["a kind with capitals", "kind=Track"],
    ["an empty kind", "kind="],
    ["two kinds", "kind=track&kind=artist"],
    ["a limit of zero", "limit=0"],
    ["a negative limit", "limit=-1"],
    ["a limit above 100", "limit=101"],
    ["a limit that is not a whole number", "limit=2.5"],
    ["a limit in exponent form", "limit=1e1"],
    ["a limit that is not a number", "limit=abc"],
    ["an empty limit", "limit="],
    ["a huge limit", "limit=99999999999999999999"],
    ["two limits", "limit=5&limit=6"],
  ])("answers 400 with no detail for %s", async (_label, query) => {
    const res = await getChart(query);

    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "bad_request" });
  });

  it("echoes nothing the caller sent", async () => {
    const res = await getChart("week=%3Cscript%3Ealert(1)%3C%2Fscript%3E&kind=zzz-marker&limit=qqq-marker");
    const text = await res.text();

    expect(res.status).toBe(400);
    expect(/script|marker|zzz|qqq/.test(text)).toBe(false);
  });

  it("answers 400 for a malformed value before it asks the database", async () => {
    const res = await getChart("week=abc", "refused");

    expect(res.status).toBe(400);
  });

  it.each([
    ["a parameter the route does not know", "foo=1"],
    ["a known value with a parameter the route does not know", "week=2026-02-02&utm=x"],
    ["a cache-busting random value", "kind=track&cb=8f3a2c"],
    ["a parameter with no value", "foo"],
    ["a parameter with no name", "=x"],
    ["a parameter named like a database argument", "p_delay_days=0"],
    ["a known name in capitals", "Week=2026-02-02"],
    ["a known name in capitals beside valid ones", "limit=5&KIND=track"],
  ])("answers 400 with no detail for %s, before it asks the database", async (_label, query) => {
    // The refused site has no database. A 400 here proves the check ran first. A 503 would mean it asked.
    for (const site of ["healthy", "refused"] as SiteName[]) {
      const res = await getChart(query, site);

      expect(res.status, site).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ status: "bad_request" });
    }
  });

  it("does not echo an unknown parameter name or value", async () => {
    const res = await getChart("zzz-marker=qqq-marker");
    const text = await res.text();

    expect(res.status).toBe(400);
    expect(/zzz|qqq|marker/.test(text)).toBe(false);
  });

  it("accepts the edges: the lowest and highest limit and each kind", async () => {
    await insertPlays([play("a", "2026-02-03T12:00:00Z")]);
    for (const q of ["limit=1", "limit=100", "kind=track", "kind=artist", "kind=album", "week=2026-02-02"]) {
      expect((await getChart(q)).status, q).toBe(200);
    }
  });
});

describe("GET /api/charts/weekly: private data", () => {
  it("returns only the listed fields, and no timestamp", async () => {
    await insertPlays([
      ...plays("a", 2, "2026-02-03T12:00:00Z"),
      play("b", "2026-02-03T13:00:00Z", { source: "poll", ms_played: null }),
    ]);
    const res = await getChart("week=2026-02-02");
    const text = await res.text();
    const body = JSON.parse(text) as Chart;

    expect(Object.keys(body)).toEqual(["week_start", "first_week", "latest_week", "kind", "rows"]);
    for (const row of body.rows) {
      expect(Object.keys(row)).toEqual([
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
    }
    expect(/\d{2}:\d{2}:\d{2}/.test(text)).toBe(false);
    expect(/ended_at|created_at|ms_played|source|\bip\b|country|device|podcast|private/i.test(text)).toBe(false);
  });

  it("holds no key, address or secret", async () => {
    await insertPlays(plays("a", 1, "2026-02-03T12:00:00Z"));
    const text = await (await getChart("week=2026-02-02")).text();

    expect(env.secrets.filter(({ value }) => text.includes(value))).toEqual([]);
    expect(text.includes(new URL(env.apiUrl).host)).toBe(false);
  });
});

describe("GET /api/charts/weekly: when the database fails", () => {
  // A request with a week and one without both reach the database first, so both must fail the same way.
  const failures: [string, SiteName, string][] = [
    ["refuses the connection", "refused", "name=TypeError code=ECONNREFUSED"],
    ["never answers", "hanging", "name=TimeoutError code=none"],
    ["rejects the key", "badKey", "name=PostgrestError code=PGRST301"],
    ["is not configured", "missingEnv", "name=ServerConfigError code=SERVER_ENV_MISSING"],
  ];

  describe.each([
    ["a week", "week=2026-02-02"],
    ["no week", ""],
  ])("on a request with %s", (_requestLabel, query) => {
    it.each(failures)(
      "answers 503 with the same body and logs a safe reason when the database %s",
      async (_label, site, reason) => {
        const started = Date.now();
        const res = await getChart(query, site);
        const body = await res.text();
        const log = await waitForSiteLog(site, "weekly chart failed");

        expect(res.status).toBe(503);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(JSON.parse(body)).toEqual({ status: "unhealthy" });
        expect(log).toContain(`weekly chart failed: ${reason}`);
        expect(env.secrets.filter(({ value }) => (body + log).includes(value))).toEqual([]);
        expect((body + log).includes(new URL(env.apiUrl).host)).toBe(false);
        expect(Date.now() - started).toBeLessThan(15_000);
      },
    );
  });

  it("logs no failure on the healthy site", () => {
    expect(readSiteLog("healthy")).not.toContain("weekly chart failed");
  });
});

describe("GET /api/charts/weekly: when the database answers in a shape the site does not expect", () => {
  // The malformed site talks to a stub that sends data the real database never would.
  it.each<[string, string, string]>([
    ["a chart row with a rank that is text", "week=2026-02-02&kind=track", "name=ChartShapeError code=CHART_SHAPE"],
    ["a chart that is not a list", "week=2026-02-02&kind=track&limit=2", "name=ChartShapeError code=CHART_SHAPE"],
    ["bounds with no latest week", "kind=artist", "name=ChartShapeError code=CHART_SHAPE"],
    ["bounds with a latest week that is not a date", "kind=album", "name=ChartShapeError code=CHART_SHAPE"],
  ])("answers 503 and logs ChartShapeError for %s", async (_label, query, reason) => {
    const res = await getChart(query, "malformed");
    const body = await res.text();
    const log = await waitForSiteLog("malformed", `weekly chart failed: ${reason}`);

    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(body)).toEqual({ status: "unhealthy" });
    expect(log).toContain(`weekly chart failed: ${reason}`);
    expect(log).not.toContain("name=TypeError code=none");
  });
});

describe.each([
  ["anon key", env.anonKey],
  ["publishable key", env.publishableKey ?? ""],
] as [string, string][])("the chart functions, called with the %s", (label, key) => {
  const calls: [string, Record<string, unknown>][] = [
    ["chart_weekly", { p_week: "2026-02-02", p_kind: "track", p_limit: 25, p_delay_days: 1 }],
    [
      "chart_weekly",
      { p_week: "2026-02-02", p_kind: "track", p_limit: 25, p_delay_days: 0, p_now: "2030-01-01T00:00:00Z" },
    ],
    ["chart_bounds", { p_kind: "track", p_delay_days: 1 }],
    ["chart_cutoff", { p_now: "2026-02-18T15:00:00Z", p_delay_days: 1 }],
  ];

  for (const [fn, args] of calls) {
    it(`refuses ${fn}${"p_now" in args ? " with p_now" : ""} to the browser roles with code 42501`, async (ctx) => {
      if (!key) {
        ctx.skip(`The Supabase CLI reported no ${label} on this machine, so this check cannot run.`);
      }
      await insertPlays(plays("a", 1, "2026-02-03T12:00:00Z"));
      const res = await fetch(`${env.apiUrl}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      const text = await res.text();
      const body = JSON.parse(text) as { code?: string };

      expect(body.code).toBe("42501");
      expect(text).not.toContain("Track a");
    });
  }
});
