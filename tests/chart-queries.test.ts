import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

// `server-only` throws outside a server build. Tests run in Node, so stub it.
vi.mock("server-only", () => ({}));

const { loadChartPage } = await import("../src/lib/chart-queries");

/**
 * Which failures count as the database being unavailable (503), and which are our own bugs (they must be thrown, so
 * the site answers 500 and nobody reads a bug as an outage). A stand-in client fails on purpose here, which the HTTP
 * tests cannot do for a bug. Nothing in this file reads a real database.
 */
function failingWith(error: unknown): SupabaseClient {
  return {
    rpc: () => ({ retry: () => ({ throwOnError: () => Promise.reject(error) }) }),
  } as unknown as SupabaseClient;
}

function answering(data: unknown): SupabaseClient {
  return {
    rpc: () => ({ retry: () => ({ throwOnError: () => Promise.resolve({ data }) }) }),
  } as unknown as SupabaseClient;
}

const view = { kind: "track", week: null } as const;

afterEach(() => vi.restoreAllMocks());

describe("loadChartPage", () => {
  it.each<[string, unknown]>([
    ["a refused connection", Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })],
    ["a timeout", new DOMException("The operation timed out.", "TimeoutError")],
    ["an abort", new DOMException("aborted", "AbortError")],
    ["a database error from PostgREST", Object.assign(new Error("JWT invalid"), { name: "PostgrestError", code: "PGRST301", details: "", hint: "" })],
  ])("answers unavailable for %s", async (_label, error) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(loadChartPage(view, failingWith(error))).resolves.toEqual({ status: "unavailable" });
  });

  it("answers unavailable when the database sends a shape the page does not know", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(loadChartPage(view, answering("not a table"))).resolves.toEqual({ status: "unavailable" });
  });

  it("logs a short reason and never the message of the error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await loadChartPage(view, failingWith(Object.assign(new TypeError("secret-address-123 failed"), { cause: { code: "ECONNREFUSED" } })));
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).not.toContain("secret-address-123");
    expect(String(log.mock.calls[0]![0])).toContain("ECONNREFUSED");
  });

  it.each<[string, unknown]>([
    ["a RangeError", new RangeError("Invalid time value")],
    ["a TypeError from our own code", new TypeError("Cannot read properties of undefined")],
    ["a plain Error", new Error("bug")],
  ])("throws %s, so it is never taken for an outage", async (_label, error) => {
    await expect(loadChartPage(view, failingWith(error))).rejects.toBe(error);
  });
});
