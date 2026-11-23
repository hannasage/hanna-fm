import { gunzipSync, gzipSync } from "node:zlib";
import {
  resolveWeek,
  type ChartPageData,
  type ChartsView,
} from "./chart-page";
import { toChartBounds, toChartRows } from "./charts";
import { ChartShapeError } from "./failure-reason";

/**
 * The proxy reads the database once for a Charts request, because only the proxy can set the HTTP status of the answer.
 * It hands what it read to the page in this request header, as gzip and URL-safe base64, so the page never asks again.
 * The proxy sets the header on every /charts request and replaces any value a caller sent.
 * The page still checks the value: the rows go through the same validators as a database answer, and the state must
 * fit the address the page itself reads.
 */
export const HANDOFF_HEADER = "x-chart-handoff";

type Wire =
  | { s: "ok"; b: BoundsWire; r: unknown }
  | { s: "out_of_range"; b: BoundsWire }
  | { s: "no_data" | "invalid" | "unavailable" };

type BoundsWire = { first_week: string | null; latest_week: string | null; current_week: string };

export function encodeHandoff(data: ChartPageData): string {
  const bounds = (): BoundsWire => {
    if (data.status !== "ok" && data.status !== "out_of_range") throw new Error("This state holds no bounds.");
    return { first_week: data.bounds.firstWeek, latest_week: data.bounds.latestWeek, current_week: data.bounds.currentWeek };
  };
  const wire: Wire =
    data.status === "ok"
      ? { s: "ok", b: bounds(), r: data.rows }
      : data.status === "out_of_range"
        ? { s: "out_of_range", b: bounds() }
        : { s: data.status };
  return gzipSync(JSON.stringify(wire)).toString("base64url");
}

/**
 * Reads the header back. `view` is what the page read from its own address, or null when the address is not valid.
 * Any value that does not fit throws, so a wrong or forged header ends in a 500 and never in a wrong chart.
 */
export function decodeHandoff(text: string, view: ChartsView | null): ChartPageData {
  const wire = JSON.parse(gunzipSync(Buffer.from(text, "base64url")).toString("utf8")) as Wire;
  if (typeof wire !== "object" || wire === null) throw new ChartShapeError();

  if (wire.s === "invalid") {
    if (view !== null) throw new ChartShapeError();
    return { status: "invalid" };
  }
  if (view === null) throw new ChartShapeError();

  switch (wire.s) {
    case "no_data":
    case "unavailable":
      return { status: wire.s };
    case "out_of_range": {
      const bounds = toChartBounds([wire.b]);
      if (resolveWeek(view.week, bounds).status !== "out_of_range") throw new ChartShapeError();
      return { status: "out_of_range", bounds };
    }
    case "ok": {
      const bounds = toChartBounds([wire.b]);
      const choice = resolveWeek(view.week, bounds);
      if (choice.status !== "ok") throw new ChartShapeError();
      return { status: "ok", bounds, choice, rows: toChartRows(wire.r) };
    }
    default:
      throw new ChartShapeError();
  }
}
