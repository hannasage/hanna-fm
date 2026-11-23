import {
  PUBLIC_DELAY_DAYS,
  parseChartQuery,
  toChartBounds,
  toChartRows,
  weekInRange,
} from "@/lib/charts";
import { failureReason } from "@/lib/failure-reason";
import { createServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * A chart changes only at Eastern midnight, so a shared cache may keep one for five minutes,
 * and serve it stale for ten more while it fetches a fresh one. Errors are never cached.
 */
const OK_HEADERS = { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" };
const ERROR_HEADERS = { "Cache-Control": "no-store" };

/**
 * Each database call gets this long. The chart query runs over every play up to the week, so it gets more
 * time than a health check. The functions stop themselves at 5 seconds, so this ends the wait, not the query.
 */
const CHART_TIMEOUT_MS = 8_000;

export async function GET(request: Request): Promise<Response> {
  const query = parseChartQuery(new URL(request.url).searchParams);
  if (!query) {
    // Nothing about the bad value goes back to the caller.
    return Response.json({ status: "bad_request" }, { status: 400, headers: ERROR_HEADERS });
  }

  try {
    const db = createServerSupabase(CHART_TIMEOUT_MS);

    // The database holds the clock and the week rules, so the range and the default week come from it.
    const { data: boundsData } = await db
      .rpc("chart_bounds", { p_kind: query.kind, p_delay_days: PUBLIC_DELAY_DAYS })
      .retry(false)
      .throwOnError();
    const bounds = toChartBounds(boundsData);

    let week: string;
    if (query.week === null) {
      if (bounds.latestWeek === null) {
        // No play qualifies yet. Say so, rather than showing the current week as if it were quiet.
        return Response.json(
          { week_start: null, kind: query.kind, rows: [], status: "no_data" },
          { status: 200, headers: OK_HEADERS },
        );
      }
      week = bounds.latestWeek;
    } else {
      if (!weekInRange(query.week, bounds)) {
        return Response.json({ status: "bad_request" }, { status: 400, headers: ERROR_HEADERS });
      }
      week = query.week;
    }

    const { data } = await db
      .rpc("chart_weekly", {
        p_week: week,
        p_kind: query.kind,
        p_limit: query.limit,
        p_delay_days: PUBLIC_DELAY_DAYS,
      })
      .retry(false)
      .throwOnError();

    return Response.json(
      { week_start: week, kind: query.kind, rows: toChartRows(data) },
      { status: 200, headers: OK_HEADERS },
    );
  } catch (error) {
    // The log gets a sanitized reason. The caller only learns the chart is unavailable.
    console.error(`weekly chart failed: ${failureReason(error)}`);
    return Response.json({ status: "unhealthy" }, { status: 503, headers: ERROR_HEADERS });
  }
}
