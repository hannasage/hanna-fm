import { describe, expect, it } from "vitest";
import type { ChartRow } from "../src/lib/charts";
import {
  addWeeks,
  chartsHref,
  defaultWeek,
  displayName,
  flagOf,
  formatDay,
  formatWeek,
  lastWeekLabel,
  movementOf,
  cacheControlFor,
  parseChartsParams,
  parseChartsSearch,
  resolveWeek,
  statusFor,
  weeksBetween,
} from "../src/lib/chart-page";

/** The rules of the Charts page that need no database and no clock. */

const ROW: ChartRow = {
  rank: 4,
  key: "k",
  name: "Song",
  artist: "Band",
  plays: 10,
  minutes: 30,
  last_week_rank: 4,
  peak_rank: 2,
  weeks_on_chart: 5,
};

describe("flagOf", () => {
  it("calls a first week on the chart NEW", () => {
    expect(flagOf({ ...ROW, last_week_rank: null, weeks_on_chart: 1 })).toBe("NEW");
  });

  it("calls a return after a gap RE-ENTRY: no rank last week, more than one week on the chart", () => {
    expect(flagOf({ ...ROW, last_week_rank: null, weeks_on_chart: 2 })).toBe("RE-ENTRY");
    expect(flagOf({ ...ROW, last_week_rank: null, weeks_on_chart: 30 })).toBe("RE-ENTRY");
  });

  it("gives no flag to a row that was on the chart last week", () => {
    expect(flagOf({ ...ROW, last_week_rank: 3, weeks_on_chart: 2 })).toBeNull();
  });

  it("goes by weeks on chart alone for NEW, whatever last week says", () => {
    expect(flagOf({ ...ROW, last_week_rank: 3, weeks_on_chart: 1 })).toBe("NEW");
  });
});

describe("movementOf", () => {
  it("is up when the rank number fell, with the number of steps", () => {
    expect(movementOf({ ...ROW, rank: 2, last_week_rank: 5 })).toEqual({ direction: "up", steps: 3 });
  });

  it("is down when the rank number rose", () => {
    expect(movementOf({ ...ROW, rank: 9, last_week_rank: 6 })).toEqual({ direction: "down", steps: 3 });
  });

  it("is same when the rank did not change", () => {
    expect(movementOf({ ...ROW, rank: 4, last_week_rank: 4 })).toEqual({ direction: "same", steps: 0 });
  });

  it("is none for NEW and for RE-ENTRY", () => {
    expect(movementOf({ ...ROW, last_week_rank: null, weeks_on_chart: 1 }).direction).toBe("none");
    expect(movementOf({ ...ROW, last_week_rank: null, weeks_on_chart: 4 }).direction).toBe("none");
  });

  it("is none for a NEW row even if the data also holds a last week rank", () => {
    expect(movementOf({ ...ROW, last_week_rank: 2, weeks_on_chart: 1 }).direction).toBe("none");
  });
});

describe("lastWeekLabel", () => {
  it("shows the rank as a number, and an en dash when there is none", () => {
    expect(lastWeekLabel({ ...ROW, last_week_rank: 7 })).toBe("7");
    expect(lastWeekLabel({ ...ROW, last_week_rank: null })).toBe("–");
  });
});

describe("displayName", () => {
  it("drops the artist from an album name, which the chart writes as Album - Artist", () => {
    expect(displayName("album", { ...ROW, name: "Record - Band", artist: "Band" })).toBe("Record");
  });

  it("leaves a track name and an artist name as they are", () => {
    expect(displayName("track", { ...ROW, name: "Song - Band", artist: "Band" })).toBe("Song - Band");
    expect(displayName("artist", { ...ROW, name: "Band", artist: null })).toBe("Band");
  });

  it("leaves an album name alone when it does not end with the artist", () => {
    expect(displayName("album", { ...ROW, name: "Record - Other", artist: "Band" })).toBe("Record - Other");
  });

  it("keeps an album that is named exactly like the suffix", () => {
    expect(displayName("album", { ...ROW, name: " - Band", artist: "Band" })).toBe(" - Band");
  });
});

describe("addWeeks and weeksBetween", () => {
  it("moves a Monday by whole weeks, across a month and a year", () => {
    expect(addWeeks("2026-02-02", 1)).toBe("2026-02-09");
    expect(addWeeks("2026-01-05", -1)).toBe("2025-12-29");
    expect(addWeeks("2026-03-02", -4)).toBe("2026-02-02");
  });

  it("moves across a month end, a year end and a leap day", () => {
    expect(addWeeks("2026-03-02", 1)).toBe("2026-03-09");
    expect(addWeeks("2026-10-26", 1)).toBe("2026-11-02");
    expect(addWeeks("2025-12-29", 1)).toBe("2026-01-05");
    // 2028 is a leap year: the week of Monday 2028-02-28 holds Tuesday 2028-02-29.
    expect(addWeeks("2028-02-28", 1)).toBe("2028-03-06");
    expect(addWeeks("2028-03-06", -1)).toBe("2028-02-28");
    expect(addWeeks("2028-02-21", 2)).toBe("2028-03-06");
  });

  it("is not shifted by a change of clocks in New York", () => {
    expect(addWeeks("2026-03-02", 1)).toBe("2026-03-09");
    expect(addWeeks("2026-10-26", 1)).toBe("2026-11-02");
    expect(addWeeks("2026-11-02", -1)).toBe("2026-10-26");
  });

  it("lists the weeks from the latest back to the first", () => {
    expect(weeksBetween("2026-02-02", "2026-02-16")).toEqual(["2026-02-16", "2026-02-09", "2026-02-02"]);
    expect(weeksBetween("2026-02-02", "2026-02-02")).toEqual(["2026-02-02"]);
  });
});

describe("defaultWeek", () => {
  const first = "2026-02-02";

  it("is the latest week when it is already finished", () => {
    expect(defaultWeek({ firstWeek: first, latestWeek: "2026-02-16", currentWeek: "2026-02-23" })).toEqual({
      week: "2026-02-16",
      inProgress: false,
    });
  });

  it("is the week before the latest when the latest is the week still running", () => {
    expect(defaultWeek({ firstWeek: first, latestWeek: "2026-02-23", currentWeek: "2026-02-23" })).toEqual({
      week: "2026-02-16",
      inProgress: false,
    });
  });

  it("takes the week before when that week is exactly the first week", () => {
    expect(defaultWeek({ firstWeek: "2026-02-16", latestWeek: "2026-02-23", currentWeek: "2026-02-23" })).toEqual({
      week: "2026-02-16",
      inProgress: false,
    });
  });

  it("shows the running week, flagged, when it is the only week", () => {
    expect(defaultWeek({ firstWeek: "2026-02-23", latestWeek: "2026-02-23", currentWeek: "2026-02-23" })).toEqual({
      week: "2026-02-23",
      inProgress: true,
    });
  });

  it("is null when no play qualifies", () => {
    expect(defaultWeek({ firstWeek: null, latestWeek: null, currentWeek: "2026-02-23" })).toBeNull();
  });
});

describe("resolveWeek", () => {
  const bounds = { firstWeek: "2026-02-02", latestWeek: "2026-02-16", currentWeek: "2026-02-23" };

  it("uses the default when no week is asked for", () => {
    expect(resolveWeek(null, bounds)).toEqual({
      status: "ok",
      week: "2026-02-16",
      inProgress: false,
      previous: "2026-02-09",
      next: null,
    });
  });

  it("gives the neighbours inside the range only", () => {
    expect(resolveWeek("2026-02-09", bounds)).toMatchObject({ previous: "2026-02-02", next: "2026-02-16" });
    expect(resolveWeek("2026-02-02", bounds)).toMatchObject({ previous: null, next: "2026-02-09" });
  });

  it("flags the week that is still running, when it is asked for by name", () => {
    const running = { firstWeek: "2026-02-02", latestWeek: "2026-02-23", currentWeek: "2026-02-23" };
    expect(resolveWeek("2026-02-23", running)).toMatchObject({ status: "ok", inProgress: true });
    expect(resolveWeek("2026-02-16", running)).toMatchObject({ status: "ok", inProgress: false, next: "2026-02-23" });
  });

  it("says out of range for a week before the first or after the latest", () => {
    expect(resolveWeek("2026-01-26", bounds)).toEqual({ status: "out_of_range" });
    expect(resolveWeek("2026-02-23", bounds)).toEqual({ status: "out_of_range" });
  });

  it("says no data when the database holds no qualifying play", () => {
    const empty = { firstWeek: null, latestWeek: null, currentWeek: "2026-02-23" };
    expect(resolveWeek(null, empty)).toEqual({ status: "no_data" });
    expect(resolveWeek("2026-02-16", empty)).toEqual({ status: "no_data" });
  });
});

describe("parseChartsParams", () => {
  it("defaults to the track chart and no week", () => {
    expect(parseChartsParams({})).toEqual({ kind: "track", week: null });
  });

  it("reads a kind and a Monday", () => {
    expect(parseChartsParams({ kind: "album", week: "2026-02-09" })).toEqual({ kind: "album", week: "2026-02-09" });
  });

  it.each<[string, Record<string, string | string[] | undefined>]>([
    ["an unknown kind", { kind: "genre" }],
    ["a kind with the wrong case", { kind: "Track" }],
    ["an empty kind", { kind: "" }],
    ["a repeated kind", { kind: ["track", "album"] }],
    ["a date that is not a Monday", { week: "2026-02-10" }],
    ["text that is not a date", { week: "last-week" }],
    ["a date that does not exist", { week: "2026-02-30" }],
    ["a repeated week", { week: ["2026-02-02", "2026-02-09"] }],
    ["an empty week", { week: "" }],
  ])("refuses %s", (_label, params) => {
    expect(parseChartsParams(params)).toBeNull();
  });

  it("ignores parameters it does not know, such as a tracking tag", () => {
    expect(parseChartsParams({ utm_source: "x", kind: "artist" })).toEqual({ kind: "artist", week: null });
  });
});

describe("chartsHref", () => {
  it("leaves the default kind and week out", () => {
    expect(chartsHref({ kind: "track", week: null })).toBe("/charts");
  });

  it("writes the kind and week it is given", () => {
    expect(chartsHref({ kind: "album", week: null })).toBe("/charts?kind=album");
    expect(chartsHref({ kind: "artist", week: "2026-02-09" })).toBe("/charts?kind=artist&week=2026-02-09");
    expect(chartsHref({ kind: "track", week: "2026-02-09" })).toBe("/charts?week=2026-02-09");
  });
});

describe("formatWeek", () => {
  it("writes the Monday to Sunday span, with the year once at the end", () => {
    expect(formatWeek("2026-02-09")).toBe("Feb 9 – Feb 15, 2026");
  });

  it("names both years when the week crosses New Year", () => {
    expect(formatWeek("2025-12-29")).toBe("Dec 29, 2025 – Jan 4, 2026");
  });
});

describe("formatDay", () => {
  it("writes one date with its year", () => {
    expect(formatDay("2026-02-02")).toBe("Feb 2, 2026");
    expect(formatDay("2025-12-29")).toBe("Dec 29, 2025");
  });
});

describe("parseChartsSearch", () => {
  it("reads the same rules from a query string, and sees a name given twice", () => {
    expect(parseChartsSearch(new URLSearchParams("kind=album&week=2026-02-09"))).toEqual({ kind: "album", week: "2026-02-09" });
    expect(parseChartsSearch(new URLSearchParams("kind=album&kind=track"))).toBeNull();
    expect(parseChartsSearch(new URLSearchParams("week=2026-02-10"))).toBeNull();
    expect(parseChartsSearch(new URLSearchParams("utm_source=a"))).toEqual({ kind: "track", week: null });
  });
});

describe("statusFor and cacheControlFor", () => {
  const bounds = { firstWeek: "2026-02-02", latestWeek: "2026-02-16", currentWeek: "2026-02-23" };
  const choice = resolveWeek(null, bounds);
  if (choice.status !== "ok") throw new Error("test setup");

  it("maps each state of the page to a status", () => {
    expect(statusFor({ status: "ok", bounds, choice, rows: [] })).toBe(200);
    expect(statusFor({ status: "no_data" })).toBe(200);
    expect(statusFor({ status: "invalid" })).toBe(400);
    expect(statusFor({ status: "out_of_range", bounds })).toBe(404);
    expect(statusFor({ status: "unavailable" })).toBe(503);
  });

  it("lets a shared cache keep only a chart, as the API does, and no other state", () => {
    expect(cacheControlFor({ status: "ok", bounds, choice, rows: [] })).toBe("public, s-maxage=300, stale-while-revalidate=600");
    for (const data of [
      { status: "no_data" },
      { status: "invalid" },
      { status: "out_of_range", bounds },
      { status: "unavailable" },
    ] as const) {
      expect(cacheControlFor(data)).toBe("no-store");
    }
  });
});
