import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveWeek, type ChartPageData, type ChartsView } from "./chart-page";
import {
  DEFAULT_CHART_LIMIT,
  PUBLIC_DELAY_DAYS,
  toChartBounds,
  toChartRows,
  type ChartBounds,
  type ChartKind,
  type ChartRow,
} from "./charts";
import { ChartShapeError, failureReason } from "./failure-reason";
import { ServerConfigError, createServerSupabase } from "./supabase/server";

/**
 * Each database call gets this long. The chart query runs over every play up to the week, so it gets more
 * time than a health check. The functions stop themselves at 5 seconds, so this ends the wait, not the query.
 */
export const CHART_TIMEOUT_MS = 8_000;

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

/**
 * True for a failure of the database or of the way to it: a refused or cut connection, a timeout, an error answer from
 * PostgREST, an answer in a shape the site does not know, or a missing setting. Anything else is a bug in this code,
 * and it must not be shown as an outage.
 */
export function isDatabaseFailure(error: unknown): boolean {
  if (error instanceof ChartShapeError || error instanceof ServerConfigError) return true;
  if (typeof error !== "object" || error === null) return false;
  const { name, cause } = error as { name?: unknown; cause?: unknown };
  if (name === "AbortError" || name === "TimeoutError" || name === "PostgrestError") return true;
  // Node's fetch reports a network failure as a TypeError with the system error as its cause.
  return error instanceof TypeError && typeof cause === "object" && cause !== null;
}

/**
 * Everything the Charts page needs for one view. The database says which weeks exist and which week is now,
 * and the page rules pick the week. A database failure becomes `unavailable`, with only a sanitized reason logged.
 * Any other error is thrown, so the site answers 500 and the fault is not read as an outage.
 * `db` is for a test that must make the database fail in a way a real one cannot be made to.
 */
export async function loadChartPage(view: ChartsView, db?: SupabaseClient): Promise<ChartPageData> {
  try {
    const client = db ?? createServerSupabase(CHART_TIMEOUT_MS);
    const bounds = await fetchChartBounds(client, view.kind);
    const choice = resolveWeek(view.week, bounds);
    if (choice.status === "no_data") return { status: "no_data" };
    if (choice.status === "out_of_range") return { status: "out_of_range", bounds };
    const rows = await fetchChartRows(client, choice.week, view.kind, DEFAULT_CHART_LIMIT);
    return { status: "ok", bounds, choice, rows };
  } catch (error) {
    if (!isDatabaseFailure(error)) throw error;
    console.error(`charts page failed: ${failureReason(error)}`);
    return { status: "unavailable" };
  }
}
