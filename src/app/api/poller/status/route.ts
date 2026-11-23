import { failureReason } from "@/lib/failure-reason";
import {
  LOGIN_STATE_KEY,
  loginHealth,
  pollerStatus,
  toPollerRun,
  toStateValue,
} from "@/lib/poller-status";
import { createServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Poller health changes by the hour, so a shared cache may keep an answer for a minute.
 * Errors are never cached.
 */
const OK_HEADERS = { "Cache-Control": "public, s-maxage=60" };
const ERROR_HEADERS = { "Cache-Control": "no-store" };

export async function GET(request: Request): Promise<Response> {
  if (new URL(request.url).searchParams.size > 0) {
    // The route takes no parameter, so none can move the clock or a setting.
    return Response.json({ status: "bad_request" }, { status: 400, headers: ERROR_HEADERS });
  }

  try {
    const db = createServerSupabase();
    const newestRun = (outcome?: "ok" | "failed") => {
      let query = db.from("poller_runs").select("outcome, finished_at, failure_kind");
      if (outcome) query = query.eq("outcome", outcome);
      // The finish time orders runs. The id breaks a tie, so the answer never flips between calls.
      // `limit(1)` keeps the API row limit out of it, and the finished_at index serves each query.
      return query
        .order("finished_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1)
        .retry(false)
        .throwOnError();
    };

    const [latest, newestOk, lastFailure, login] = await Promise.all([
      newestRun(),
      newestRun("ok"),
      newestRun("failed"),
      db
        .from("poller_state")
        .select("value")
        .eq("key", LOGIN_STATE_KEY)
        .limit(1)
        .retry(false)
        .throwOnError(),
    ]);

    // One reading of the clock serves every rule, and no caller can set it.
    const now = Date.now();
    const runStatus = pollerStatus(
      {
        latest: toPollerRun(latest.data),
        newestOk: toPollerRun(newestOk.data),
        lastFailure: toPollerRun(lastFailure.data),
      },
      now,
    );

    return Response.json(
      {
        status: runStatus.status,
        last_ok_at: runStatus.last_ok_at,
        last_failure: runStatus.last_failure,
        login: loginHealth(toStateValue(login.data), now),
      },
      { status: 200, headers: OK_HEADERS },
    );
  } catch (error) {
    // The log gets a sanitized reason. The caller only learns the status is unavailable.
    console.error(`poller status failed: ${failureReason(error)}`);
    return Response.json({ status: "unhealthy" }, { status: 503, headers: ERROR_HEADERS });
  }
}
