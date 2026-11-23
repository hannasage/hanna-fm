import { describe, expect, it } from "vitest";
import { toChartRow, toChartRows } from "../src/lib/charts";
import { ChartShapeError } from "../src/lib/failure-reason";

/** The field-by-field copy of a chart row. Nothing here touches a database. */
const GOOD = {
  rank: 1,
  key: "k",
  name: "n",
  artist: "a",
  plays: 3,
  minutes: 7,
  last_week_rank: null,
  peak_rank: 1,
  weeks_on_chart: 2,
};

describe("toChartRow", () => {
  it("copies the listed fields, with the artist after the name", () => {
    expect(Object.keys(toChartRow(GOOD))).toEqual([
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
    expect(toChartRow(GOOD)).toEqual(GOOD);
  });

  it("accepts a null artist, which is what an artist row carries", () => {
    expect(toChartRow({ ...GOOD, artist: null }).artist).toBeNull();
  });

  it("drops any field it does not list", () => {
    const row = toChartRow({ ...GOOD, ended_at: "2026-02-03T12:00:00Z", ms_played: 200000, source: "poll", extra: { a: 1 } });

    expect(row).toEqual(GOOD);
    expect(Object.keys(row)).not.toContain("ended_at");
  });

  it.each<[string, unknown]>([
    ["a missing artist", { ...GOOD, artist: undefined }],
    ["a number for the artist", { ...GOOD, artist: 5 }],
    ["an object for the artist", { ...GOOD, artist: { name: "a" } }],
    ["a text rank", { ...GOOD, rank: "1" }],
    ["a missing name", { ...GOOD, name: undefined }],
    ["null", null],
    ["a string", "row"],
    ["undefined", undefined],
  ])("throws ChartShapeError for %s", (_label, value) => {
    expect(() => toChartRow(value)).toThrow(ChartShapeError);
  });
});

describe("toChartRows", () => {
  it("copies every row", () => {
    expect(toChartRows([GOOD, { ...GOOD, rank: 2, artist: null }])).toHaveLength(2);
  });

  it("throws ChartShapeError when one row has the wrong shape or the data is not a list", () => {
    expect(() => toChartRows([GOOD, { ...GOOD, artist: 1 }])).toThrow(ChartShapeError);
    expect(() => toChartRows({ rows: [] })).toThrow(ChartShapeError);
    expect(() => toChartRows(null)).toThrow(ChartShapeError);
  });
});
