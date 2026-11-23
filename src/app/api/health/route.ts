import { createServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

export async function GET(): Promise<Response> {
  try {
    const { error } = await createServerSupabase()
      .from("health_check")
      .select("id")
      .limit(1)
      // A health check reports the first failure at once. It never retries.
      .retry(false);
    if (error) throw error;
    return Response.json({ status: "healthy" }, { status: 200, headers });
  } catch {
    // The reason stays on the server. The caller only learns the database did not answer.
    return Response.json({ status: "unhealthy" }, { status: 503, headers });
  }
}
