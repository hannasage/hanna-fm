import { failureReason } from "@/lib/failure-reason";
import { createServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

export async function GET(): Promise<Response> {
  try {
    // `limit(0)` asks for the count only, so no row crosses the wire and the API row
    // limit does not cap the answer. A GET, not a HEAD, so a failure keeps its error code.
    const { count } = await createServerSupabase()
      .from("plays")
      .select("id", { count: "exact" })
      .limit(0)
      // Like the health check, it reports the first failure at once. It never retries.
      .retry(false)
      .throwOnError();
    if (typeof count !== "number" || !Number.isInteger(count)) {
      throw new TypeError("The database returned no usable count.");
    }
    return Response.json({ count }, { status: 200, headers });
  } catch (error) {
    // The log gets a sanitized reason. The caller only learns the count is unavailable.
    console.error(`plays count failed: ${failureReason(error)}`);
    return Response.json({ status: "unhealthy" }, { status: 503, headers });
  }
}
