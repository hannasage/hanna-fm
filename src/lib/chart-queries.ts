import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  PUBLIC_DELAY_DAYS,
  toChartBounds,
  toChartRows,
  type ChartBounds,
  type ChartKind,
  type ChartRow,
} from "./charts";
import { resolveWeek, type ChartsView, type WeekChoice } from "./chart-page";
import { failureReason } from "./failure-reason";
import { createServerSupabase } from "./supabase/server";

/**
 * Each database call gets this long. The chart query runs over every play up to the week, so it gets more
 * time than a health check. The functions stop themselves at 5 seconds, so this ends the wait, not the query.
 */
export const CHART_TIMEOUT_MS = 8_000;

/** How many rows the Charts page asks for. */
export const PAGE_CHART_LIMIT = 25;

/** The weeks the database holds for one kind, and which week it is now in New York. */
export async function fetchChartBounds(db: SupabaseClient, kind: ChartKind): Promise<ChartBounds> {
  const { data } = await db
    .rpc("chart_bounds", { p_kind: kind, p_delay_days: PUBLIC_DELAY_DAYS })
    .retry(false)
    .throwOnError();
  return toChartBounds(data);
}

/** The rows of one chart week. The week must already be checked against the bounds. */
export async function fetchChartRows(
  db: SupabaseClient,
  week: string,
  kind: ChartKind,
  limit: number,
): Promise<ChartRow[]> {
  const { data } = await db
    .rpc("chart_weekly", { p_week: week, p_kind: kind, p_limit: limit, p_delay_days: PUBLIC_DELAY_DAYS })
    .retry(false)
    .throwOnError();
  return toChartRows(data);
}

export type ChartPageData =
  | { status: "ok"; bounds: ChartBounds; choice: Extract<WeekChoice, { status: "ok" }>; rows: ChartRow[] }
  | { status: "no_data" }
  | { status: "out_of_range"; bounds: ChartBounds }
  | { status: "unavailable" };

/**
 * Everything the Charts page needs for one view. The database says which weeks exist and which week is now,
 * and the page rules pick the week. Any failure becomes `unavailable`, and only a sanitized reason is logged.
 */
export async function loadChartPage(view: ChartsView): Promise<ChartPageData> {
  try {
    const db = createServerSupabase(CHART_TIMEOUT_MS);
    const bounds = await fetchChartBounds(db, view.kind);
    const choice = resolveWeek(view.week, bounds);
    if (choice.status === "no_data") return { status: "no_data" };
    if (choice.status === "out_of_range") return { status: "out_of_range", bounds };
    const rows = await fetchChartRows(db, choice.week, view.kind, PAGE_CHART_LIMIT);
    return { status: "ok", bounds, choice, rows };
  } catch (error) {
    console.error(`charts page failed: ${failureReason(error)}`);
    return { status: "unavailable" };
  }
}
