import { PollerStatusShapeError, failureReason } from "@/lib/failure-reason";
import {
  LOGIN_STATE_KEY,
  httpStatusFor,
  newestTrustedFinish,
  pollerHealth,
  toPollerRun,
  toStateValue,
} from "@/lib/poller-status";
import { createServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/poller/status: poller health and the Spotify login warning. Read-only.
 *
 * Body:
 *  - `status`: `no_runs`, `ok`, `stale` (newest ok run over 2 hours old) or `failing` (the
 *    latest run failed).
 *  - `last_ok_at`, `last_failure` ({ at, kind }): the newest ok run and the newest failure.
 *  - `last_stored_at`: the finish time of the newest ok run that stored more than 0 plays, or null.
 *  - `login.state`: `unknown` (the key is absent), `ok`, `expiring` (150 days or more old and
 *    under 180) or `expired` (180 days or more). A value that is there but unreadable, or in
 *    the future, is `expiring`, so that someone looks at it. No day count is given.
 *  - `attention`: fixed strings, in this order, each a reason to look. It holds any of
 *    `login_unknown`, `login_expiring`, `login_expired`, `no_stores_recently` (the status is ok
 *    and the last store is missing or over 7 days old) and `clock_skew` (a run finished more
 *    than 5 minutes ahead of the clock; that run is ignored for every other field).
 *
 * HTTP code, so a monitor can watch the code alone:
 *  - 200 when the status is ok, with any of the warnings `login_unknown`, `login_expiring`,
 *    `no_stores_recently` or `clock_skew`. It may be cached for a minute.
 *  - 503, with the same body and `no-store`, when the status is `stale`, `failing` or
 *    `no_runs`, or the login is `expired`.
 *  - 503 `{ "status": "unhealthy" }` when the database cannot be read.
 *  - 400 `{ "status": "bad_request" }` for any query parameter.
 */

/**
 * Poller health changes by the hour, so a shared cache may keep a 200 for a minute.
 * Anything else is never cached.
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
    // One reading of the clock serves every rule, and no caller can set it.
    const now = Date.now();
    const cutoff = new Date(newestTrustedFinish(now)).toISOString();
    const newestRun = (outcome?: "ok" | "failed", stored?: boolean) => {
      let query = db.from("poller_runs").select("outcome, finished_at, failure_kind");
      if (outcome) query = query.eq("outcome", outcome);
      if (stored) query = query.gt("stored", 0);
      // A run finished ahead of the clock is left out here, so the older runs still count.
      query = query.lte("finished_at", cutoff);
      // The finish time orders runs. The id breaks a tie, so the answer never flips between calls.
      // `limit(1)` keeps the API row limit out of it, and the finished_at index serves each query.
      return query
        .order("finished_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1)
        .retry(false)
        .throwOnError();
    };

    const [latest, newestOk, lastFailure, lastStored, ahead, login] = await Promise.all([
      newestRun(),
      newestRun("ok"),
      newestRun("failed"),
      newestRun("ok", true),
      db
        .from("poller_runs")
        .select("id")
        .gt("finished_at", cutoff)
        .limit(1)
        .retry(false)
        .throwOnError(),
      db
        .from("poller_state")
        .select("value")
        .eq("key", LOGIN_STATE_KEY)
        .limit(1)
        .retry(false)
        .throwOnError(),
    ]);

    if (!Array.isArray(ahead.data)) throw new PollerStatusShapeError();

    const health = pollerHealth(
      {
        runs: {
          latest: toPollerRun(latest.data),
          newestOk: toPollerRun(newestOk.data),
          lastFailure: toPollerRun(lastFailure.data),
          lastStored: toPollerRun(lastStored.data),
        },
        loginValue: toStateValue(login.data),
        futureRunSeen: ahead.data.length > 0,
      },
      now,
    );

    // The same body either way. The code and the cache header say whether to raise an alarm.
    const code = httpStatusFor(health);
    return Response.json(health, { status: code, headers: code === 200 ? OK_HEADERS : ERROR_HEADERS });
  } catch (error) {
    // The log gets a sanitized reason. The caller only learns the status is unavailable.
    console.error(`poller status failed: ${failureReason(error)}`);
    return Response.json({ status: "unhealthy" }, { status: 503, headers: ERROR_HEADERS });
  }
}
