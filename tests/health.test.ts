import { describe, expect, it } from "vitest";
import { readSiteLog, testEnv, waitForSiteLog, type SiteName } from "./support/env";

async function getHealth(site: SiteName) {
  return fetch(`${testEnv().sites[site]}/api/health`);
}

describe("GET /api/health over HTTP", () => {
  it("reports healthy when the database answers", async () => {
    const res = await getHealth("healthy");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toEqual({ status: "healthy" });
    expect(readSiteLog("healthy")).not.toContain("health check failed");
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

  describe.each<[string, SiteName, string]>([
    ["the database refuses the connection", "refused", "name=TypeError code=ECONNREFUSED"],
    ["the database never answers", "hanging", "name=TimeoutError code=none"],
    ["the database rejects the key (PostgREST 401)", "badKey", "name=PostgrestError code=PGRST301"],
    ["a database variable is missing", "missingEnv", "name=ServerConfigError code=SERVER_ENV_MISSING"],
  ])("when %s", (_label, site, reason) => {
    it("answers 503 with the same unhealthy body", async () => {
      const started = Date.now();
      const res = await getHealth(site);

      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(await res.json()).toEqual({ status: "unhealthy" });
      expect(Date.now() - started).toBeLessThan(8_000);
    });

    it("logs a sanitized reason on the server", async () => {
      await getHealth(site);
      const log = await waitForSiteLog(site, "health check failed");

      expect(log).toContain(`health check failed: ${reason}`);
    });

    it("leaks no secret, address or message to the caller or the log", async () => {
      const { secrets, apiUrl } = testEnv();
      const res = await getHealth(site);
      const body = await res.text();
      const log = await waitForSiteLog(site, "health check failed");

      const leaked = secrets
        .filter(({ value }) => body.includes(value) || log.includes(value))
        .map(({ name }) => name);
      expect(leaked).toEqual([]);
      expect(body.includes("not-a-real-key") || log.includes("not-a-real-key")).toBe(false);
      expect((body + log).includes(new URL(apiUrl).host)).toBe(false);
      expect(/fetch failed|Expected 3 parts|Caused by/i.test(body + log)).toBe(false);
    });
  });
});
