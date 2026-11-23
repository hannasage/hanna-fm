import { ChartShapeError } from "./failure-reason";

/**
 * Rules for the weekly chart inputs. Nothing here touches the database.
 * The week, play and delay rules live in the SQL functions `chart_weekly`, `chart_bounds` and `chart_cutoff`.
 */

/**
 * The one setting for the public delay. Plays from the last whole Eastern day or more are hidden:
 * the database snaps the cutoff to the start of the Eastern day this many days back, and never closer
 * than 24 hours. A chart number therefore changes only at Eastern midnight.
 */
export const PUBLIC_DELAY_DAYS = 1;

export const CHART_KINDS = ["track", "artist", "album"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

export const DEFAULT_CHART_LIMIT = 25;
export const MAX_CHART_LIMIT = 100;

export type ChartQuery = {
  /** A Monday, as YYYY-MM-DD, or null when the caller did not ask for one. */
  week: string | null;
  kind: ChartKind;
  limit: number;
};

function once(params: URLSearchParams, name: string): string | null | "invalid" {
  const values = params.getAll(name);
  if (values.length === 0) return null;
  if (values.length > 1) return "invalid";
  return values[0]!;
}

/** True for a real calendar date written YYYY-MM-DD. */
function isIsoDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === text;
}

/** True for a real calendar date written YYYY-MM-DD that falls on a Monday. */
function isMonday(text: string): boolean {
  return isIsoDate(text) && new Date(`${text}T00:00:00Z`).getUTCDay() === 1;
}

/** The only query parameters the route reads. Any other name is refused, so a caller cannot invent cache keys. */
const ALLOWED_PARAMS: readonly string[] = ["week", "kind", "limit"];

/**
 * Reads the query string. Returns null for any parameter or value that is not allowed.
 * It never says which one was wrong, because the caller learns nothing from a 400.
 */
export function parseChartQuery(params: URLSearchParams): ChartQuery | null {
  for (const name of params.keys()) {
    if (!ALLOWED_PARAMS.includes(name)) return null;
  }
  const week = once(params, "week");
  const kind = once(params, "kind");
  const limit = once(params, "limit");
  if (week === "invalid" || kind === "invalid" || limit === "invalid") return null;

  if (week !== null && !isMonday(week)) return null;
  if (kind !== null && !(CHART_KINDS as readonly string[]).includes(kind)) return null;
  if (limit !== null) {
    if (!/^\d{1,9}$/.test(limit)) return null;
    const n = Number(limit);
    if (n < 1 || n > MAX_CHART_LIMIT) return null;
  }

  return {
    week,
    kind: (kind ?? "track") as ChartKind,
    limit: limit === null ? DEFAULT_CHART_LIMIT : Number(limit),
  };
}

/** What the database says about the weeks it holds. */
export type ChartBounds = {
  /** The Monday of the first stored play, or null when nothing is stored. */
  firstWeek: string | null;
  /** The Monday of the latest week with a play the chart would count, or null when none qualifies. */
  latestWeek: string | null;
  /** The Monday of the current New York week. */
  currentWeek: string;
};

/**
 * Reads the one row `chart_bounds` returns. A null latest week is a real answer (no play qualifies).
 * A latest week that is missing, or not a date, is not, and throws.
 */
export function toChartBounds(data: unknown): ChartBounds {
  if (!Array.isArray(data) || data.length !== 1 || typeof data[0] !== "object" || data[0] === null) {
    throw new ChartShapeError();
  }
  const row = data[0] as Record<string, unknown>;
  const date = (value: unknown): string => {
    if (typeof value !== "string" || !isIsoDate(value)) throw new ChartShapeError();
    return value;
  };
  const currentWeek = date(row.current_week);
  const firstWeek = row.first_week === null ? null : date(row.first_week);
  const latestWeek = row.latest_week === null ? null : date(row.latest_week);
  if (firstWeek === null && latestWeek !== null) throw new ChartShapeError();
  return { firstWeek, latestWeek, currentWeek };
}

/** True when a week the caller named lies between the first stored week and the current week. */
export function weekInRange(week: string, bounds: ChartBounds): boolean {
  return bounds.firstWeek !== null && week >= bounds.firstWeek && week <= bounds.currentWeek;
}

/** One line of a chart. Only these fields leave the site. */
export type ChartRow = {
  rank: number;
  key: string;
  name: string;
  plays: number;
  /** Whole minutes. A row never shows the exact length of one play. */
  minutes: number;
  last_week_rank: number | null;
  peak_rank: number;
  weeks_on_chart: number;
};

function whole(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ChartShapeError();
  }
  return value;
}

/** Copies a database row into a ChartRow. Any field not listed here is dropped. */
export function toChartRow(raw: unknown): ChartRow {
  if (typeof raw !== "object" || raw === null) {
    throw new ChartShapeError();
  }
  const row = raw as Record<string, unknown>;
  if (typeof row.key !== "string" || typeof row.name !== "string") {
    throw new ChartShapeError();
  }
  return {
    rank: whole(row.rank),
    key: row.key,
    name: row.name,
    plays: whole(row.plays),
    minutes: whole(row.minutes),
    last_week_rank: row.last_week_rank === null ? null : whole(row.last_week_rank),
    peak_rank: whole(row.peak_rank),
    weeks_on_chart: whole(row.weeks_on_chart),
  };
}

/** Copies every row of a chart. Anything that is not a list is a shape error. */
export function toChartRows(data: unknown): ChartRow[] {
  if (!Array.isArray(data)) throw new ChartShapeError();
  return data.map(toChartRow);
}
