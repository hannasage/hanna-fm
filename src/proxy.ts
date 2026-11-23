import { NextResponse, type NextRequest } from "next/server";
import { HANDOFF_HEADER, encodeHandoff } from "./lib/chart-handoff";
import { cacheControlFor, parseChartsSearch, statusFor, type ChartPageData } from "./lib/chart-page";
import { loadChartPage } from "./lib/chart-queries";

/** How long a visitor is asked to wait after an outage, in seconds. The page says "in a minute". */
const RETRY_AFTER_SECONDS = "60";

/**
 * A Next.js page cannot set its own HTTP status, and a status cannot change once the page has begun to stream.
 * So the Charts request is read here first. This proxy reads the address and the database once, picks the status
 * (400, 404, 503 or 200) and the cache policy, and hands what it read to the page in a request header.
 * A status other than 200 is sent by rewriting to the same address with that status; the page then draws the message.
 * An error that is not a database failure is not caught here, so the request ends in a 500.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const view = parseChartsSearch(request.nextUrl.searchParams);
  const data: ChartPageData = view === null ? { status: "invalid" } : await loadChartPage(view);
  const status = statusFor(data);

  // The header is set last and always replaces a value from the caller.
  const headers = new Headers(request.headers);
  headers.set(HANDOFF_HEADER, encodeHandoff(data));

  // The rewrite goes to this same address. The destination must have the origin the server itself reports, which a
  // clone of the request's own URL always has.
  const response =
    status === 200
      ? NextResponse.next({ request: { headers } })
      : NextResponse.rewrite(request.nextUrl.clone(), { status, request: { headers } });
  response.headers.set("Cache-Control", cacheControlFor(data));
  if (status === 503) response.headers.set("Retry-After", RETRY_AFTER_SECONDS);
  return response;
}

export const config = { matcher: "/charts" };
