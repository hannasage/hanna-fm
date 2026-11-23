import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearPlays, insertPlays, plays, withDb, type Chart, type ChartRow } from "./support/chart-data";
import { testEnv } from "./support/env";

/**
 * The chart over 200,000 plays. All rows are synthetic and made by the database itself.
 * The bulk plays run from 2025-01-06 to 2026-02-26, with skewed counts, so ranks are spread out and ties are rare
 * near the top. Three later weeks hold a small fixture whose ranks are worked out by hand.
 */
const env = testEnv();

const FULL = 200_000;

/**
 * Each chart must arrive inside this budget. It is about five times the slowest chart measured on a
 * developer laptop (0.10 to 0.18 seconds over five runs, both database calls included), so a slower CI
 * machine passes and a route that reads rows into code, or scans the table once per row, still fails.
 */
const BUDGET_MS = 900;

/** A Monday in the middle of the bulk history. */
const MID_HISTORY_WEEK = "2025-09-01";

const KEYS = {
  track: { key: "track_uri", name: "track_name", artist: "artist_name", where: "true" },
  artist: { key: "artist_name", name: "artist_name", artist: "null::text", where: "true" },
  album: {
    key: "md5(album_name) || '.' || md5(artist_name)",
    name: "album_name || ' - ' || artist_name",
    artist: "artist_name",
    where: "album_name is not null",
  },
} as const;

/**
 * The chart worked out a second way. It reads every play, finds each week by day-of-week arithmetic on the
 * New York clock, ranks with row_number, and looks up last week, the peak and the weeks on chart with
 * one lookup each. It shares no function with the code under test.
 */
function independentChart(kind: keyof typeof KEYS): string {
  const k = KEYS[kind];
  return `
    with qualifying as (
      select ended_at at time zone 'America/New_York' as local_time,
             ${k.key} as item_key, ${k.name} as item_name, ${k.artist} as item_artist, coalesce(ms_played, 0) as ms
        from public.plays
       where (ms_played is null or ms_played >= 30000) and ${k.where}
    ),
    weekly as (
      select (local_time::date - (extract(isodow from local_time)::int - 1)) as week,
             item_key, max(item_name) as item_name, max(item_artist) as item_artist, count(*) as plays, sum(ms) as ms
        from qualifying
       group by 1, 2
    ),
    ranked as (
      select w.*, row_number() over (
               partition by week
               order by plays desc, ms desc, lower(item_name) collate "C", item_name collate "C", item_key collate "C"
             ) as rnk
        from weekly w
    )
    select cur.rnk::int as rank, cur.item_key as key, cur.item_name as name, cur.item_artist as artist, cur.plays::int as plays,
           round(cur.ms / 60000.0)::int as minutes,
           (select p.rnk::int from ranked p where p.item_key = cur.item_key and p.week = cur.week - 7) as last_week_rank,
           (select min(h.rnk)::int from ranked h where h.item_key = cur.item_key and h.week <= cur.week) as peak_rank,
           (select count(*)::int from ranked h where h.item_key = cur.item_key and h.week <= cur.week) as weeks_on_chart
      from ranked cur
     where cur.week = $1::date
     order by cur.rnk
     limit 100`;
}

describe(`GET /api/charts/weekly with ${FULL.toLocaleString("en-US")} plays`, () => {
  beforeAll(async () => {
    await clearPlays();
    await withDb(async (db) => {
      // One play every 3 minutes from 2025-01-06T17:00Z. The track number is skewed by a cube, and shifted
      // each week, so a few tracks get many plays, most get few, and the leaders change from week to week.
      // One play in ten has no ms_played (a poll row), one in ten is under 30 seconds.
      await db.query(
        `insert into public.plays (track_uri, track_name, artist_name, album_name, ended_at, ms_played, source)
         select 'spotify:track:perf' || t.n,
                'Perf Track ' || t.n,
                'Perf Artist ' || (t.n % 400),
                'Perf Album ' || (t.n % 800),
                timestamptz '2025-01-06 17:00:00+00' + (g.i * 180) * interval '1 second',
                case when g.i % 10 = 0 then null
                     when g.i % 10 = 1 then 10000
                     else 30000 + ((g.i * 37) % 270000) end,
                case when g.i % 10 = 0 then 'poll' else 'export' end
           from generate_series(1, $1::int) as g(i),
                lateral (select floor(3000 * power((((g.i * 7919) + (g.i / 3360) * 1301) % 10007) / 10007.0, 3))::int as n) as t`,
        [FULL],
      );
    });
    // Three later weeks with a small fixture, ranks worked out by hand (see the test below).
    await insertPlays([
      // Week of 2026-04-06: A 5 plays, C 3 plays of 2 minutes, B 3 plays of 1 minute -> A1 C2 B3.
      ...plays("known-a", 5, "2026-04-07T12:00:00Z", { ms_played: 60_000 }),
      ...plays("known-c", 3, "2026-04-07T13:00:00Z", { ms_played: 120_000 }),
      ...plays("known-b", 3, "2026-04-07T14:00:00Z", { ms_played: 60_000 }),
      // Week of 2026-04-13: B 6 plays, D 2 plays of 90 seconds, A 2 plays of 1 minute -> B1 D2 A3.
      ...plays("known-b", 6, "2026-04-14T12:00:00Z", { ms_played: 60_000 }),
      ...plays("known-d", 2, "2026-04-14T13:00:00Z", { ms_played: 90_000 }),
      ...plays("known-a", 2, "2026-04-14T14:00:00Z", { ms_played: 60_000 }),
      // Week of 2026-04-20: A 7 plays, D 2 plays of 30 seconds, B 1 play -> A1 D2 B3.
      ...plays("known-a", 7, "2026-04-21T12:00:00Z", { ms_played: 60_000 }),
      ...plays("known-d", 2, "2026-04-21T13:00:00Z", { ms_played: 30_000 }),
      ...plays("known-b", 1, "2026-04-21T14:00:00Z", { ms_played: 60_000 }),
    ]);
    await withDb((db) => db.query("analyze public.plays"));
  });

  afterAll(async () => {
    await withDb((db) => db.query("truncate public.plays"));
  });

  it("holds the plays the tests expect", async () => {
    const count = await withDb((db) => db.query<{ n: string }>("select count(*) as n from public.plays"));

    expect(Number(count.rows[0]!.n)).toBe(FULL + 5 + 3 + 3 + 6 + 2 + 2 + 7 + 2 + 1);
  });

  it.each<["track" | "artist" | "album"]>([["track"], ["artist"], ["album"]])(
    "answers the %s chart for a week in the middle of the history, the same as a second query, inside the budget",
    async (kind) => {
      const expected = await withDb((db) =>
        db.query<ChartRow>(independentChart(kind), [MID_HISTORY_WEEK]),
      );

      const started = performance.now();
      const res = await fetch(
        `${env.sites.healthy}/api/charts/weekly?week=${MID_HISTORY_WEEK}&kind=${kind}&limit=100`,
      );
      const body = (await res.json()) as Chart;
      const elapsed = performance.now() - started;

      expect(res.status).toBe(200);
      expect(body.week_start).toBe(MID_HISTORY_WEEK);
      expect(body.rows).toHaveLength(100);
      expect(body.rows).toEqual(expected.rows);
      // The plays are spread out: the leader is well ahead of the 100th, and the counts are not all the same.
      expect(body.rows[0]!.plays).toBeGreaterThan(body.rows[99]!.plays);
      expect(new Set(body.rows.map((r) => r.plays)).size).toBeGreaterThan(5);
      expect(body.rows.some((r) => r.last_week_rank !== null)).toBe(true);
      expect(body.rows.some((r) => r.weeks_on_chart > 1)).toBe(true);
      expect(elapsed, `${kind} chart took ${Math.round(elapsed)} ms`).toBeLessThan(BUDGET_MS);
    },
  );

  it("gives the hand-worked ranks for the fixture weeks, among the bulk history", async () => {
    const third = await (await fetch(`${env.sites.healthy}/api/charts/weekly?week=2026-04-20`)).json();
    const second = await (await fetch(`${env.sites.healthy}/api/charts/weekly?week=2026-04-13`)).json();
    const first = await (await fetch(`${env.sites.healthy}/api/charts/weekly?week=2026-04-06`)).json();

    expect((first as Chart).rows).toEqual([
      { rank: 1, key: "spotify:track:synthetic-known-a", name: "Track known-a", artist: "Artist known-a", plays: 5, minutes: 5, last_week_rank: null, peak_rank: 1, weeks_on_chart: 1 },
      { rank: 2, key: "spotify:track:synthetic-known-c", name: "Track known-c", artist: "Artist known-c", plays: 3, minutes: 6, last_week_rank: null, peak_rank: 2, weeks_on_chart: 1 },
      { rank: 3, key: "spotify:track:synthetic-known-b", name: "Track known-b", artist: "Artist known-b", plays: 3, minutes: 3, last_week_rank: null, peak_rank: 3, weeks_on_chart: 1 },
    ]);
    expect((second as Chart).rows).toEqual([
      { rank: 1, key: "spotify:track:synthetic-known-b", name: "Track known-b", artist: "Artist known-b", plays: 6, minutes: 6, last_week_rank: 3, peak_rank: 1, weeks_on_chart: 2 },
      { rank: 2, key: "spotify:track:synthetic-known-d", name: "Track known-d", artist: "Artist known-d", plays: 2, minutes: 3, last_week_rank: null, peak_rank: 2, weeks_on_chart: 1 },
      { rank: 3, key: "spotify:track:synthetic-known-a", name: "Track known-a", artist: "Artist known-a", plays: 2, minutes: 2, last_week_rank: 1, peak_rank: 1, weeks_on_chart: 2 },
    ]);
    expect((third as Chart).rows).toEqual([
      { rank: 1, key: "spotify:track:synthetic-known-a", name: "Track known-a", artist: "Artist known-a", plays: 7, minutes: 7, last_week_rank: 3, peak_rank: 1, weeks_on_chart: 3 },
      { rank: 2, key: "spotify:track:synthetic-known-d", name: "Track known-d", artist: "Artist known-d", plays: 2, minutes: 1, last_week_rank: 2, peak_rank: 2, weeks_on_chart: 2 },
      { rank: 3, key: "spotify:track:synthetic-known-b", name: "Track known-b", artist: "Artist known-b", plays: 1, minutes: 1, last_week_rank: 1, peak_rank: 1, weeks_on_chart: 3 },
    ]);
  });

  it("picks the latest fixture week when no week is given", async () => {
    const res = await fetch(`${env.sites.healthy}/api/charts/weekly`);
    const body = (await res.json()) as Chart;

    expect(body.week_start).toBe("2026-04-20");
    expect(body.rows.map((r) => r.name)).toEqual(["Track known-a", "Track known-d", "Track known-b"]);
  });
});
