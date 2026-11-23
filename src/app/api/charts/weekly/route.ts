import {
  chartWeekStart,
  parseChartQuery,
  publicCutoff,
  toChartRow,
} from "@/lib/charts";
import { failureReason } from "@/lib/failure-reason";
import { createServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

/** The chart query runs over every play up to the week, so it gets more time than a health check. */
const CHART_TIMEOUT_MS = 8_000;

export async function GET(request: Request): Promise<Response> {
  const query = parseChartQuery(new URL(request.url).searchParams);
  if (!query) {
    // Nothing about the bad value goes back to the caller.
    return Response.json({ status: "bad_request" }, { status: 400, headers });
  }

  try {
    const db = createServerSupabase(CHART_TIMEOUT_MS);
    const cutoff = publicCutoff();

    let week = query.week;
    if (week === null) {
      // The latest week that holds a play the public may see. With no play at all, this week.
      const { data } = await db
        .from("plays")
        .select("ended_at")
        .lte("ended_at", cutoff.toISOString())
        .order("ended_at", { ascending: false })
        .limit(1)
        .retry(false)
        .throwOnError();
      const latest = data?.[0]?.ended_at;
      week = chartWeekStart(typeof latest === "string" ? new Date(latest) : new Date());
    }

    const { data } = await db
      .rpc("chart_weekly", {
        p_week: week,
        p_kind: query.kind,
        p_limit: query.limit,
        p_cutoff: cutoff.toISOString(),
      })
      .retry(false)
      .throwOnError();
    if (!Array.isArray(data)) {
      throw new TypeError("The database returned no chart.");
    }

    return Response.json(
      { week_start: week, kind: query.kind, rows: data.map(toChartRow) },
      { status: 200, headers },
    );
  } catch (error) {
    // The log gets a sanitized reason. The caller only learns the chart is unavailable.
    console.error(`weekly chart failed: ${failureReason(error)}`);
    return Response.json({ status: "unhealthy" }, { status: 503, headers });
  }
}
