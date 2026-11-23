import { describe, expect, it } from "vitest";
import { testEnv } from "./support/env";

describe("GET /api/health over HTTP", () => {
  it("reports healthy when the database answers", async () => {
    const res = await fetch(`${testEnv().healthySiteUrl}/api/health`);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toEqual({ status: "healthy" });
  });

  it("reads a real row that the fixture loaded", async () => {
    const { apiUrl, serviceRoleKey } = testEnv();
    const res = await fetch(`${apiUrl}/rest/v1/health_check?select=id,label`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    });

    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: number; label: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.label).toBe("synthetic fixture row");
  });

  it("reports unhealthy when the database refuses the connection", async () => {
    const res = await fetch(`${testEnv().refusedSiteUrl}/api/health`);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "unhealthy" });
  });

  it("reports unhealthy when the database never answers", async () => {
    const started = Date.now();
    const res = await fetch(`${testEnv().hangingSiteUrl}/api/health`);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "unhealthy" });
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it("does not leak error details when unhealthy", async () => {
    const res = await fetch(`${testEnv().refusedSiteUrl}/api/health`);
    const text = await res.text();

    expect(text).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|fetch failed|stack/i);
  });
});
