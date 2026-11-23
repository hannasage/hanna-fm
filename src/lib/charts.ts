/**
 * Rules for the weekly chart inputs. Nothing here touches the database.
 * The week and play rules live in the SQL function `chart_weekly`.
 */

/** Plays newer than this many hours never appear in public data. The one setting for the delay. */
export const PUBLIC_DELAY_HOURS = 24;

export const CHART_KINDS = ["track", "artist", "album"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

export const DEFAULT_CHART_LIMIT = 25;
export const MAX_CHART_LIMIT = 100;

const CHART_TIME_ZONE = "America/New_York";
const DAY_MS = 86_400_000;

export type ChartQuery = {
  /** A Monday, as YYYY-MM-DD, or null when the caller did not ask for one. */
  week: string | null;
  kind: ChartKind;
  limit: number;
};

/** The newest play time the public may see, given the clock. */
export function publicCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - PUBLIC_DELAY_HOURS * 3_600_000);
}

function once(params: URLSearchParams, name: string): string | null | "invalid" {
  const values = params.getAll(name);
  if (values.length === 0) return null;
  if (values.length > 1) return "invalid";
  return values[0]!;
}

/** True for a real calendar date written YYYY-MM-DD that falls on a Monday. */
function isMonday(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10) === text && date.getUTCDay() === 1;
}

/**
 * Reads the query string. Returns null for any value that is not allowed.
 * It never says which value was wrong, because the caller learns nothing from a 400.
 */
export function parseChartQuery(params: URLSearchParams): ChartQuery | null {
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

/** The Monday, in New York, of the chart week that holds a moment. */
export function chartWeekStart(moment: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: CHART_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    })
      .formatToParts(moment)
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  const daysSinceMonday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday!);
  const localMidnight = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  return new Date(localMidnight - daysSinceMonday * DAY_MS).toISOString().slice(0, 10);
}

/** One line of a chart. Only these fields leave the site. */
export type ChartRow = {
  rank: number;
  key: string;
  name: string;
  plays: number;
  minutes: number;
  last_week_rank: number | null;
  peak_rank: number;
  weeks_on_chart: number;
};

function whole(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError("The database returned a chart row that is not usable.");
  }
  return value;
}

/** Copies a database row into a ChartRow. Any field not listed here is dropped. */
export function toChartRow(raw: unknown): ChartRow {
  if (typeof raw !== "object" || raw === null) {
    throw new TypeError("The database returned a chart row that is not usable.");
  }
  const row = raw as Record<string, unknown>;
  if (typeof row.key !== "string" || typeof row.name !== "string" || typeof row.minutes !== "number") {
    throw new TypeError("The database returned a chart row that is not usable.");
  }
  return {
    rank: whole(row.rank),
    key: row.key,
    name: row.name,
    plays: whole(row.plays),
    minutes: row.minutes,
    last_week_rank: row.last_week_rank === null ? null : whole(row.last_week_rank),
    peak_rank: whole(row.peak_rank),
    weeks_on_chart: whole(row.weeks_on_chart),
  };
}
