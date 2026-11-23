import { CHART_KINDS, parseChartQuery, type ChartBounds, type ChartKind, type ChartRow } from "./charts";

/**
 * Rules for the Charts page that need no database and no clock.
 * The ranking rules stay in the database. Here live only the reading of the address, the choice of week
 * and the labels a row gets from the numbers it already holds.
 */

export type ChartsView = { kind: ChartKind; week: string | null };

export type SearchParams = Record<string, string | string[] | undefined>;

/** The only two parameters the page reads. Any other, such as a tracking tag, is ignored. */
const PAGE_PARAMS = ["kind", "week"] as const;

/**
 * Reads the page address. Returns null for a kind that is not a chart, for a week that is not a Monday date,
 * and for a name given twice. The week and kind rules are the route's own, so the page and the API agree.
 */
export function parseChartsParams(params: SearchParams): ChartsView | null {
  const search = new URLSearchParams();
  for (const name of PAGE_PARAMS) {
    const value = params[name];
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) search.append(name, one);
  }
  const query = parseChartQuery(search);
  return query ? { kind: query.kind, week: query.week } : null;
}

/** The address of a chart. The default kind and an unset week are left out, so the plain address stays plain. */
export function chartsHref(view: ChartsView): string {
  const search = new URLSearchParams();
  if (view.kind !== "track") search.set("kind", view.kind);
  if (view.week !== null) search.set("week", view.week);
  const text = search.toString();
  return text ? `/charts?${text}` : "/charts";
}

export const KIND_LABELS: Record<ChartKind, string> = {
  track: "Tracks",
  artist: "Artists",
  album: "Albums",
};

export const KIND_TABS: readonly { kind: ChartKind; label: string }[] = CHART_KINDS.map((kind) => ({
  kind,
  label: KIND_LABELS[kind],
}));

const DAY_MS = 86_400_000;

/** Moves a date written YYYY-MM-DD by a number of whole weeks. The date must be real. */
export function addWeeks(week: string, count: number): string {
  return new Date(Date.parse(`${week}T00:00:00Z`) + count * 7 * DAY_MS).toISOString().slice(0, 10);
}

/** Every Monday from the first week to the latest, newest first. */
export function weeksBetween(first: string, latest: string): string[] {
  const weeks: string[] = [];
  for (let week = latest; week >= first; week = addWeeks(week, -1)) weeks.push(week);
  return weeks;
}

export type WeekBounds = Pick<ChartBounds, "firstWeek" | "latestWeek" | "currentWeek">;

/**
 * The week the page opens on, and whether it is still running.
 * A chart trails real time, so from Wednesday to Sunday the latest chart week is the one still running.
 * That week is half a chart, so the page opens on the week before it, when that week is on the chart.
 * Only when the running week is the only week does it open there, flagged as in progress.
 * The current week is the database's own reading of the New York week, never the browser's clock.
 */
export function defaultWeek(bounds: WeekBounds): { week: string; inProgress: boolean } | null {
  const { firstWeek, latestWeek, currentWeek } = bounds;
  if (firstWeek === null || latestWeek === null) return null;
  if (latestWeek < currentWeek) return { week: latestWeek, inProgress: false };
  const before = addWeeks(latestWeek, -1);
  if (before >= firstWeek) return { week: before, inProgress: false };
  return { week: latestWeek, inProgress: true };
}

export type WeekChoice =
  | { status: "no_data" }
  | { status: "out_of_range" }
  | {
      status: "ok";
      week: string;
      /** True when the week is the one still running, so the chart is not final. */
      inProgress: boolean;
      /** The week before, or null at the first week. */
      previous: string | null;
      /** The week after, or null at the latest week. */
      next: string | null;
    };

/** Picks the week to show. A week the caller named must lie between the first and the latest week. */
export function resolveWeek(requested: string | null, bounds: WeekBounds): WeekChoice {
  const { firstWeek, latestWeek, currentWeek } = bounds;
  if (firstWeek === null || latestWeek === null) return { status: "no_data" };

  let week: string;
  if (requested === null) {
    const chosen = defaultWeek(bounds);
    if (chosen === null) return { status: "no_data" };
    week = chosen.week;
  } else {
    if (requested < firstWeek || requested > latestWeek) return { status: "out_of_range" };
    week = requested;
  }

  const before = addWeeks(week, -1);
  const after = addWeeks(week, 1);
  return {
    status: "ok",
    week,
    inProgress: week >= currentWeek,
    previous: before >= firstWeek ? before : null,
    next: after <= latestWeek ? after : null,
  };
}

export type RowFlag = "NEW" | "RE-ENTRY";

/**
 * NEW: the first week on the chart. RE-ENTRY: back after a gap, so no rank last week but more than one week on the chart.
 * Both are read from the row, which holds everything the label needs.
 */
export function flagOf(row: Pick<ChartRow, "last_week_rank" | "weeks_on_chart">): RowFlag | null {
  if (row.weeks_on_chart === 1) return "NEW";
  if (row.last_week_rank === null && row.weeks_on_chart > 1) return "RE-ENTRY";
  return null;
}

export type Movement = { direction: "up" | "down" | "same" | "none"; steps: number };

/** How a row moved since last week. A row with a flag has no movement. A lower rank number is higher on the chart. */
export function movementOf(row: Pick<ChartRow, "rank" | "last_week_rank" | "weeks_on_chart">): Movement {
  if (flagOf(row) !== null || row.last_week_rank === null) return { direction: "none", steps: 0 };
  const steps = row.last_week_rank - row.rank;
  if (steps > 0) return { direction: "up", steps };
  if (steps < 0) return { direction: "down", steps: -steps };
  return { direction: "same", steps: 0 };
}

/** Last week's rank as a number, or an en dash when the row had none. */
export function lastWeekLabel(row: Pick<ChartRow, "last_week_rank">): string {
  return row.last_week_rank === null ? "–" : String(row.last_week_rank);
}

/**
 * The name shown for a row. The chart writes an album as "Album - Artist", and the artist is shown on its own line,
 * so the suffix is cut off an album name, and only when it is exactly the artist.
 */
export function displayName(kind: ChartKind, row: Pick<ChartRow, "name" | "artist">): string {
  if (kind !== "album" || row.artist === null) return row.name;
  const suffix = ` - ${row.artist}`;
  if (row.name.length > suffix.length && row.name.endsWith(suffix)) return row.name.slice(0, -suffix.length);
  return row.name;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function dayText(date: string, withYear: boolean): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return `${MONTHS[month - 1]} ${day}${withYear ? `, ${year}` : ""}`;
}

/** One date as text, for example "Feb 2, 2026". */
export function formatDay(date: string): string {
  return dayText(date, true);
}

/** A week as its Monday to Sunday span, for example "Feb 9 – Feb 15, 2026". */
export function formatWeek(week: string): string {
  const end = new Date(Date.parse(`${week}T00:00:00Z`) + 6 * DAY_MS).toISOString().slice(0, 10);
  const sameYear = week.slice(0, 4) === end.slice(0, 4);
  return `${dayText(week, !sameYear)} – ${dayText(end, true)}`;
}

/** How the chart counts. One line each, in the order the page shows them. */
export const COUNTING_RULES: readonly string[] = [
  "A play is a listen of 30 seconds or more.",
  "Weeks run Monday to Sunday, Eastern time.",
  "Charts trail real time by a day.",
  "Ties break by minutes listened.",
];
