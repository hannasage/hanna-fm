import { describe, expect, it } from "vitest";
import { decodeHandoff, encodeHandoff } from "../src/lib/chart-handoff";
import { resolveWeek, type ChartPageData } from "../src/lib/chart-page";
import { ChartShapeError } from "../src/lib/failure-reason";

/** The proxy reads the database once and hands the answer to the page in a header. Nothing here touches a database. */

const bounds = { firstWeek: "2026-02-02", latestWeek: "2026-02-16", currentWeek: "2026-02-23" };
const rows = [
  { rank: 1, key: "k1", name: "<b>One</b>", artist: "Band", plays: 5, minutes: 17, last_week_rank: null, peak_rank: 1, weeks_on_chart: 1 },
  { rank: 2, key: "k2", name: "Zwei ü 🎵", artist: null, plays: 3, minutes: 9, last_week_rank: 1, peak_rank: 1, weeks_on_chart: 2 },
];
const view = { kind: "track", week: null } as const;

function okData(): ChartPageData {
  const choice = resolveWeek(null, bounds);
  if (choice.status !== "ok") throw new Error("test setup");
  return { status: "ok", bounds, choice, rows };
}

describe("the handoff between the proxy and the page", () => {
  it("round-trips a chart, with names that hold markup and Unicode", () => {
    const text = encodeHandoff(okData());
    expect(decodeHandoff(text, view)).toEqual(okData());
  });

  it("round-trips every other state", () => {
    expect(decodeHandoff(encodeHandoff({ status: "no_data" }), view)).toEqual({ status: "no_data" });
    expect(decodeHandoff(encodeHandoff({ status: "unavailable" }), view)).toEqual({ status: "unavailable" });
    expect(decodeHandoff(encodeHandoff({ status: "invalid" }), null)).toEqual({ status: "invalid" });
    const out = { status: "out_of_range", bounds } as const;
    expect(decodeHandoff(encodeHandoff(out), { kind: "track", week: "2026-03-02" })).toEqual(out);
  });

  it("is plain header text, and stays small for a full chart of long names", () => {
    const long = Array.from({ length: 100 }, (_, i) => ({ ...rows[0]!, rank: i + 1, key: `k${i}`, name: `${"Long name ".repeat(20)}${i}`, artist: "Artist ".repeat(10) }));
    const choice = resolveWeek(null, bounds);
    if (choice.status !== "ok") throw new Error("test setup");
    const text = encodeHandoff({ status: "ok", bounds, choice, rows: long });
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(text.length).toBeLessThan(6_000);
  });

  it.each([
    ["text that is not base64 of a gzip", "not a handoff"],
    ["an empty value", ""],
  ])("throws for %s", (_label, text) => {
    expect(() => decodeHandoff(text, view)).toThrow();
  });

  it("throws when the answer does not fit the address it was made for", () => {
    // A chart for the default week, read as if the address named a week that is out of range.
    expect(() => decodeHandoff(encodeHandoff(okData()), { kind: "track", week: "2026-03-02" })).toThrow();
    // An invalid address must have no view, and a valid one must not claim to be invalid.
    expect(() => decodeHandoff(encodeHandoff({ status: "invalid" }), view)).toThrow();
    expect(() => decodeHandoff(encodeHandoff({ status: "no_data" }), null)).toThrow();
  });

  it("throws a shape error for a chart row that is not a chart row", () => {
    const bad = encodeHandoff({ ...okData(), rows: [{ ...rows[0]!, rank: "1" as unknown as number }] } as ChartPageData);
    expect(() => decodeHandoff(bad, view)).toThrow(ChartShapeError);
  });
});
