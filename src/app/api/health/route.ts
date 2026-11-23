import { failureReason } from "@/lib/failure-reason";
import { createServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

export async function GET(): Promise<Response> {
  try {
    await createServerSupabase()
      .from("health_check")
      .select("id")
      .limit(1)
      // A health check reports the first failure at once. It never retries.
      .retry(false)
      // Throwing keeps the original error, with its name and cause code, for the log.
      .throwOnError();
    return Response.json({ status: "healthy" }, { status: 200, headers });
  } catch (error) {
    // The log gets a sanitized reason. The caller only learns the database did not answer.
    console.error(`health check failed: ${failureReason(error)}`);
    return Response.json({ status: "unhealthy" }, { status: 503, headers });
  }
}
