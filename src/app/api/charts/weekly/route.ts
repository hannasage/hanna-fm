import { CHART_TIMEOUT_MS, fetchChartBounds, fetchChartRows } from "@/lib/chart-queries";
import { parseChartQuery, weekInRange } from "@/lib/charts";
import { failureReason } from "@/lib/failure-reason";
import { createServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * A chart changes only at Eastern midnight, so a shared cache may keep one for five minutes,
 * and serve it stale for ten more while it fetches a fresh one. Errors are never cached.
 */
const OK_HEADERS = { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" };
const ERROR_HEADERS = { "Cache-Control": "no-store" };

export async function GET(request: Request): Promise<Response> {
  const query = parseChartQuery(new URL(request.url).searchParams);
  if (!query) {
    // Any unknown parameter, bad value or repeat lands here, before the database is asked.
    // Nothing about it goes back to the caller.
    return Response.json({ status: "bad_request" }, { status: 400, headers: ERROR_HEADERS });
  }

  try {
    const db = createServerSupabase(CHART_TIMEOUT_MS);

    // The database holds the clock and the week rules, so the range and the default week come from it.
    const bounds = await fetchChartBounds(db, query.kind);

    let week: string;
    if (query.week === null) {
      if (bounds.latestWeek === null) {
        // No play qualifies yet. Say so, rather than showing the current week as if it were quiet.
        return Response.json(
          {
            week_start: null,
            first_week: bounds.firstWeek,
            latest_week: bounds.latestWeek,
            kind: query.kind,
            rows: [],
            status: "no_data",
          },
          { status: 200, headers: OK_HEADERS },
        );
      }
      week = bounds.latestWeek;
    } else {
      // The lower bound is the first week of a play the chart counts, which only the database knows.
      // The check stays after the query, so no 400 can tell a caller more than the chart itself shows.
      if (!weekInRange(query.week, bounds)) {
        return Response.json({ status: "bad_request" }, { status: 400, headers: ERROR_HEADERS });
      }
      week = query.week;
    }

    const rows = await fetchChartRows(db, week, query.kind, query.limit);

    return Response.json(
      {
        week_start: week,
        first_week: bounds.firstWeek,
        latest_week: bounds.latestWeek,
        kind: query.kind,
        rows,
      },
      { status: 200, headers: OK_HEADERS },
    );
  } catch (error) {
    // The log gets a sanitized reason. The caller only learns the chart is unavailable.
    console.error(`weekly chart failed: ${failureReason(error)}`);
    return Response.json({ status: "unhealthy" }, { status: 503, headers: ERROR_HEADERS });
  }
}
