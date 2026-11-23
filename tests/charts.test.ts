import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readSiteLog, testEnv, waitForSiteLog, type SiteName } from "./support/env";

/**
 * Every row here is synthetic. Rows go in with the service role (or, for the 200,000
 * row test, straight into the local database) and come out again after each test.
 * Only the plays test files commit rows to plays, and the files run one at a time.
 */
const env = testEnv();

type Play = {
  track_uri: string;
  track_name: string;
  artist_name: string;
  album_name: string | null;
  ended_at: string;
  ms_played: number | null;
  source: "export" | "poll";
};

type ChartRow = {
  rank: number;
  key: string;
  name: string;
  plays: number;
  minutes: number;
  last_week_rank: number | null;
  peak_rank: number;
  weeks_on_chart: number;
};

type Chart = { week_start: string; kind: string; rows: ChartRow[] };

const FULL = 200_000;

function play(track: string, endedAt: string, overrides: Partial<Play> = {}): Play {
  return {
    track_uri: `spotify:track:synthetic-${track}`,
    track_name: `Track ${track}`,
    artist_name: `Artist ${track}`,
    album_name: `Album ${track}`,
    ended_at: new Date(endedAt).toISOString(),
    ms_played: 200_000,
    source: "export",
    ...overrides,
  };
}

/** `n` plays of one track, one minute apart from the start time, so no two clash. */
function plays(track: string, n: number, startIso: string, overrides: Partial<Play> = {}): Play[] {
  const start = new Date(startIso).getTime();
  return Array.from({ length: n }, (_, i) =>
    play(track, new Date(start + i * 60_000).toISOString(), overrides),
  );
}

function serviceHeaders(extra: Record<string, string> = {}) {
  return {
    apikey: env.serviceRoleKey,
    Authorization: `Bearer ${env.serviceRoleKey}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function insertPlays(rows: Play[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const res = await fetch(`${env.apiUrl}/rest/v1/plays`, {
      method: "POST",
      headers: serviceHeaders(),
      body: JSON.stringify(rows.slice(i, i + 500)),
    });
    expect(res.status).toBe(201);
  }
}

async function clearPlays() {
  const res = await fetch(`${env.apiUrl}/rest/v1/plays?id=gte.0`, {
    method: "DELETE",
    headers: serviceHeaders(),
  });
  expect(res.status).toBe(204);
}

async function getChart(query = "", site: SiteName = "healthy") {
  return fetch(`${env.sites[site]}/api/charts/weekly${query ? `?${query}` : ""}`);
}

async function chart(query: string): Promise<Chart> {
  const res = await getChart(query);
  expect(res.status).toBe(200);
  return (await res.json()) as Chart;
}

/** The Monday, in New York, of the week that holds a moment. Read from the clock, not from the site. */
function newYorkMonday(moment: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    })
      .formatToParts(moment)
      .map((p) => [p.type, p.value]),
  );
  const back = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday!);
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  return new Date(local - back * 86_400_000).toISOString().slice(0, 10);
}

/** The rows, cut down to the fields a test compares. */
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
    expect(c.rows).toEqual([
      { rank: 1, key: "spotify:track:synthetic-a", name: "Track a", plays: 3, minutes: 10, last_week_rank: null, peak_rank: 1, weeks_on_chart: 1 },
      { rank: 2, key: "spotify:track:synthetic-b", name: "Track b", plays: 2, minutes: 6.7, last_week_rank: null, peak_rank: 2, weeks_on_chart: 1 },
      { rank: 3, key: "spotify:track:synthetic-c", name: "Track c", plays: 1, minutes: 3.3, last_week_rank: null, peak_rank: 3, weeks_on_chart: 1 },
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

  it("without a week, shows the latest week that has plays", async () => {
    await loadThreeWeeks();
    const c = await chart("");

    expect(c.week_start).toBe("2026-02-16");
    expect(names(c)).toEqual(["Track c", "Track a", "Track b"]);
  });

  it("answers an empty week with an empty list", async () => {
    await loadThreeWeeks();
    const c = await chart("week=2026-03-02");

    expect(c).toEqual({ week_start: "2026-03-02", kind: "track", rows: [] });
  });

  it("answers with an empty list and the current Monday when no play is stored", async () => {
    const c = await chart("");

    expect(c.rows).toEqual([]);
    expect(c.week_start).toBe(newYorkMonday(new Date()));
  });

  it("sends no-store, so a new play shows at once", async () => {
    const res = await getChart("");
    expect(res.headers.get("cache-control")).toContain("no-store");
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
    await insertPlays([
      play("sunday", sunday),
      play("monday", monday),
    ]);

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
    // Week of Monday 2026-11-02 to Sunday 2026-11-08 follows fall back; Monday 10-26 to Sunday 11-01 holds it.
    await insertPlays([
      play("mon", "2026-10-26T04:00:00Z"),
      play("sun", "2026-11-02T04:59:59Z"),
    ]);

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

  it("breaks a tie in plays and minutes by name, so the order is stable", async () => {
    await insertPlays([
      ...plays("c", 1, "2026-02-03T12:00:00Z"),
      ...plays("a", 1, "2026-02-03T13:00:00Z"),
      ...plays("b", 1, "2026-02-03T14:00:00Z"),
    ]);

    for (let i = 0; i < 3; i++) {
      expect(names(await chart(week))).toEqual(["Track a", "Track b", "Track c"]);
    }
  });

  it("sums minutes over rows that have ms_played only, and counts a poll row with none", async () => {
    // Both tracks have two plays. The poll track holds 1 minute of known play time,
    // the export track 1.5 minutes. A null counted as a full play would change this.
    await insertPlays([
      play("poll", "2026-02-03T12:00:00Z", { source: "poll", ms_played: null }),
      play("poll", "2026-02-03T12:05:00Z", { source: "poll", ms_played: 60_000 }),
      ...plays("export", 2, "2026-02-03T13:00:00Z", { ms_played: 45_000 }),
    ]);
    const c = await chart(week);

    expect(c.rows.map((r) => [r.name, r.plays, r.minutes])).toEqual([
      ["Track export", 2, 1.5],
      ["Track poll", 2, 1],
    ]);
  });

  it("counts a track with only poll rows with no ms_played, at zero minutes", async () => {
    await insertPlays(plays("onlypoll", 3, "2026-02-03T12:00:00Z", { source: "poll", ms_played: null }));

    expect((await chart(week)).rows).toEqual([
      { rank: 1, key: "spotify:track:synthetic-onlypoll", name: "Track onlypoll", plays: 3, minutes: 0, last_week_rank: null, peak_rank: 1, weeks_on_chart: 1 },
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

    expect(c.rows.map((r) => [r.name, r.plays, r.minutes])).toEqual([["Track edge", 1, 0.5]]);
  });

  it("does not let a short play lift a peak or a weeks on chart", async () => {
    await insertPlays([
      play("x", "2026-02-03T12:00:00Z"),
      play("x", "2026-02-10T12:00:00Z", { ms_played: 10_000 }),
    ]);
    const c = await chart("week=2026-02-09");

    expect(c.rows).toEqual([]);
    expect((await chart(week)).rows[0]).toMatchObject({ weeks_on_chart: 1 });
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

  it("groups by album and artist, so two artists with one album name stay apart", async () => {
    await loadKinds();
    const c = await chart("week=2026-02-02&kind=album");

    expect(c.kind).toBe("album");
    expect(c.rows.map((r) => [r.key, r.plays])).toEqual([
      ["Album One - Artist One", 2],
      ["Album One - Artist Two", 1],
      ["Album Two - Artist One", 1],
    ]);
    expect(new Set(c.rows.map((r) => r.key)).size).toBe(3);
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
      { rank: 1, key: "Other", name: "Other", plays: 3, minutes: 10, last_week_rank: 2, peak_rank: 1, weeks_on_chart: 2 },
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

describe("GET /api/charts/weekly: the public delay", () => {
  const HOUR = 3_600_000;
  const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

  it("never shows a play newer than 24 hours, and counts the older ones", async () => {
    await insertPlays([
      play("old", ago(25)),
      play("old", ago(23)),
      play("fresh", ago(23.5)),
      play("fresh", ago(1)),
    ]);
    const c = await chart("");

    expect(c.rows.map((r) => [r.name, r.plays])).toEqual([["Track old", 1]]);
  });

  it("never picks a week that holds only recent plays", async () => {
    await insertPlays([play("older", "2026-02-03T12:00:00Z"), play("fresh", ago(2))]);
    const c = await chart("");

    expect(c.week_start).toBe("2026-02-02");
    expect(names(c)).toEqual(["Track older"]);
  });

  it("hides a recent play from a named week too", async () => {
    await insertPlays([play("fresh", ago(2))]);
    const c = await chart(`week=${newYorkMonday(new Date(Date.now() - 2 * HOUR))}`);

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
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toEqual({ status: "bad_request" });
  });

  it("echoes nothing the caller sent", async () => {
    const res = await getChart("week=%3Cscript%3Ealert(1)%3C%2Fscript%3E&kind=zzz-marker&limit=qqq-marker");
    const text = await res.text();

    expect(res.status).toBe(400);
    expect(/script|marker|zzz|qqq/.test(text)).toBe(false);
  });

  it("answers 400 before it asks the database", async () => {
    const res = await getChart("week=abc", "refused");

    expect(res.status).toBe(400);
  });

  it("accepts the edges: the lowest and highest limit and each kind", async () => {
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

    expect(Object.keys(body)).toEqual(["week_start", "kind", "rows"]);
    for (const row of body.rows) {
      expect(Object.keys(row)).toEqual([
        "rank",
        "key",
        "name",
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
  it.each<[string, SiteName, string]>([
    ["refuses the connection", "refused", "name=TypeError code=ECONNREFUSED"],
    ["never answers", "hanging", "name=TimeoutError code=none"],
    ["rejects the key", "badKey", "name=PostgrestError code=PGRST301"],
    ["is not configured", "missingEnv", "name=ServerConfigError code=SERVER_ENV_MISSING"],
  ])("answers 503 with the same body and logs a safe reason when the database %s", async (_label, site, reason) => {
    const started = Date.now();
    const res = await getChart("week=2026-02-02", site);
    const body = await res.text();
    const log = await waitForSiteLog(site, "weekly chart failed");

    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(JSON.parse(body)).toEqual({ status: "unhealthy" });
    expect(log).toContain(`weekly chart failed: ${reason}`);
    expect(env.secrets.filter(({ value }) => (body + log).includes(value))).toEqual([]);
    expect((body + log).includes(new URL(env.apiUrl).host)).toBe(false);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("logs no failure on the healthy site", () => {
    expect(readSiteLog("healthy")).not.toContain("weekly chart failed");
  });
});

describe.each([
  ["anon key", env.anonKey],
  ["publishable key", env.publishableKey ?? ""],
] as [string, string][])("the chart function, called with the %s", (_label, key) => {
  it("is refused to the browser roles", async () => {
    await insertPlays(plays("a", 1, "2026-02-03T12:00:00Z"));
    const res = await fetch(`${env.apiUrl}/rest/v1/rpc/chart_weekly`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        p_week: "2026-02-02",
        p_kind: "track",
        p_limit: 25,
        p_cutoff: "2026-12-01T00:00:00Z",
      }),
    });
    const text = await res.text();
    const body = JSON.parse(text) as { code?: string };

    expect(res.status === 401 || res.status === 403 || body.code === "42501").toBe(true);
    expect(text).not.toContain("Track a");
  });
});

describe("the chart function in the database", () => {
  it("is executable by the service role only", async () => {
    const db = new Client({ connectionString: env.dbUrl });
    await db.connect();
    try {
      const result = await db.query<{ role: string; allowed: boolean }>(
        `select r.role, has_function_privilege(r.role, p.oid, 'EXECUTE') as allowed
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           cross join (values ('anon'), ('authenticated'), ('service_role')) as r(role)
          where n.nspname = 'public' and p.proname = 'chart_weekly'
          order by r.role`,
      );
      expect(result.rows).toEqual([
        { role: "anon", allowed: false },
        { role: "authenticated", allowed: false },
        { role: "service_role", allowed: true },
      ]);
    } finally {
      await db.end();
    }
  });
});

describe(`GET /api/charts/weekly with ${FULL.toLocaleString("en-US")} plays`, () => {
  /**
   * Each chart must arrive inside this budget. On a developer laptop it takes about 0.3 seconds,
   * so the budget leaves room for a slower CI machine and still fails a route that reads rows into code.
   */
  const BUDGET_MS = 2_000;

  it("answers a chart with the right rows inside the time budget", async () => {
    const db = new Client({ connectionString: env.dbUrl });
    await db.connect();
    try {
      // About 99 weeks of plays, one every 5 minutes, over 3,000 tracks, 400 artists and 800 albums.
      // One play in ten has no ms_played (a poll row), one in ten is under 30 seconds.
      await db.query(
        `insert into public.plays (track_uri, track_name, artist_name, album_name, ended_at, ms_played, source)
         select 'spotify:track:perf' || (i % 3000),
                'Perf Track ' || (i % 3000),
                'Perf Artist ' || (i % 400),
                'Perf Album ' || (i % 800),
                now() - interval '3 days' - (i * 300) * interval '1 second',
                case when i % 10 = 0 then null
                     when i % 10 = 1 then 10000
                     else 30000 + (i % 270000) end,
                case when i % 10 = 0 then 'poll' else 'export' end
           from generate_series(1, $1::int) as i`,
        [FULL],
      );
      await db.query("analyze public.plays");
      const loaded = await db.query<{ n: string }>("select count(*) as n from public.plays");
      expect(Number(loaded.rows[0]!.n)).toBe(FULL);

      for (const kind of ["track", "artist", "album"]) {
        const started = performance.now();
        const res = await getChart(`kind=${kind}&limit=100`);
        const body = (await res.json()) as Chart;
        const elapsed = performance.now() - started;

        expect(res.status).toBe(200);
        expect(body.rows).toHaveLength(100);
        expect(body.rows.map((r) => r.rank)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
        const sorted = [...body.rows].sort((a, b) => b.plays - a.plays);
        expect(body.rows.map((r) => r.plays)).toEqual(sorted.map((r) => r.plays));
        expect(body.rows.every((r) => r.peak_rank >= 1 && r.weeks_on_chart >= 1)).toBe(true);
        expect(elapsed, `${kind} chart took ${Math.round(elapsed)} ms`).toBeLessThan(BUDGET_MS);
      }
    } finally {
      await db.query("truncate public.plays");
      await db.end();
    }
  });
});
