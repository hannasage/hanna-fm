import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readSiteLog, testEnv, waitForSiteLog, type SiteName } from "./support/env";

/**
 * The plays table starts empty: the seed file holds no plays. Every row here is
 * synthetic, inserted with the service role, and removed again after the file.
 * Only this file commits rows to plays, so counts here are exact.
 */
const env = testEnv();

type Play = {
  track_uri: string;
  track_name: string;
  artist_name: string;
  album_name: string | null;
  ended_at: string;
  ms_played: number | null;
  source: "export" | "poll";
};

function play(n: number, overrides: Partial<Play> = {}): Play {
  return {
    track_uri: `spotify:track:synthetic${n}`,
    track_name: `Synthetic Track ${n}`,
    artist_name: "Synthetic Artist",
    album_name: null,
    ended_at: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    ms_played: 1000 + n,
    source: "export",
    ...overrides,
  };
}

function serviceHeaders(extra: Record<string, string> = {}) {
  return {
    apikey: env.serviceRoleKey,
    Authorization: `Bearer ${env.serviceRoleKey}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function insertPlays(rows: Play[]): Promise<Response> {
  return fetch(`${env.apiUrl}/rest/v1/plays`, {
    method: "POST",
    headers: serviceHeaders(),
    body: JSON.stringify(rows),
  });
}

async function clearPlays() {
  const res = await fetch(`${env.apiUrl}/rest/v1/plays?id=gte.0`, {
    method: "DELETE",
    headers: serviceHeaders(),
  });
  expect(res.status).toBe(204);
}

async function getCount(site: SiteName = "healthy") {
  return fetch(`${env.sites[site]}/api/plays/count`);
}

beforeAll(clearPlays);
afterAll(clearPlays);

describe("GET /api/plays/count over HTTP", () => {
  it("counts zero when no play is stored", async () => {
    const res = await getCount();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toEqual({ count: 0 });
  });

  it("counts the plays stored, and sees a new play at once", async () => {
    expect((await insertPlays([play(1), play(2), play(3)])).status).toBe(201);
    expect(await (await getCount()).json()).toEqual({ count: 3 });

    expect((await insertPlays([play(4, { source: "poll", album_name: "Synthetic Album" })])).status).toBe(201);
    expect(await (await getCount()).json()).toEqual({ count: 4 });
  });

  it("answers with an integer under one key and nothing else", async () => {
    const body = (await (await getCount()).json()) as Record<string, unknown>;

    expect(Object.keys(body)).toEqual(["count"]);
    expect(Number.isInteger(body.count)).toBe(true);
  });

  it("counts past the API row limit of 1000", async () => {
    await clearPlays();
    const rows = Array.from({ length: 1500 }, (_, i) => play(i + 1));
    for (let i = 0; i < rows.length; i += 500) {
      expect((await insertPlays(rows.slice(i, i + 500))).status).toBe(201);
    }

    expect(await (await getCount()).json()).toEqual({ count: 1500 });
    await clearPlays();
  });

  describe.each<[string, SiteName, string]>([
    ["the database refuses the connection", "refused", "name=TypeError code=ECONNREFUSED"],
    ["the database never answers", "hanging", "name=TimeoutError code=none"],
    ["the database rejects the key (PostgREST 401)", "badKey", "name=PostgrestError code=PGRST301"],
    ["a database variable is missing", "missingEnv", "name=ServerConfigError code=SERVER_ENV_MISSING"],
  ])("when %s", (_label, site, reason) => {
    it("answers 503 with the same unhealthy body", async () => {
      const started = Date.now();
      const res = await getCount(site);

      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(await res.json()).toEqual({ status: "unhealthy" });
      expect(Date.now() - started).toBeLessThan(8_000);
    });

    it("logs a sanitized reason on the server", async () => {
      await getCount(site);
      const log = await waitForSiteLog(site, "plays count failed");

      expect(log).toContain(`plays count failed: ${reason}`);
    });

    it("leaks no secret, address or message to the caller or the log", async () => {
      const res = await getCount(site);
      const body = await res.text();
      const log = await waitForSiteLog(site, "plays count failed");

      const leaked = env.secrets
        .filter(({ value }) => body.includes(value) || log.includes(value))
        .map(({ name }) => name);
      expect(leaked).toEqual([]);
      expect(body.includes("not-a-real-key") || log.includes("not-a-real-key")).toBe(false);
      expect((body + log).includes(new URL(env.apiUrl).host)).toBe(false);
      expect(/fetch failed|Expected 3 parts|Caused by/i.test(body + log)).toBe(false);
    });
  });

  it("logs no failure on the healthy site", () => {
    expect(readSiteLog("healthy")).not.toContain("plays count failed");
  });
});

describe("the plays table", () => {
  // Each test starts with no rows, so none depends on what an earlier one left or cleaned up.
  beforeEach(clearPlays);

  it("rejects a second play with the same track and end time", async () => {
    await clearPlays();
    expect((await insertPlays([play(1)])).status).toBe(201);
    const res = await insertPlays([play(1, { track_name: "Other name" })]);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("23505");
    await clearPlays();
  });

  it.each<[string, Partial<Play>]>([
    ["a negative ms_played", { ms_played: -1 }],
    ["a source outside export and poll", { source: "other" as Play["source"] }],
  ])("rejects %s", async (_label, overrides) => {
    const res = await insertPlays([play(1, overrides)]);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("23514");
  });

  it("rejects a play with no track name", async () => {
    const res = await insertPlays([{ ...play(1), track_name: null } as unknown as Play]);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("23502");
  });

  it("indexes ended_at, so a range of play times needs no full scan", async () => {
    const db = new Client({ connectionString: env.dbUrl });
    await db.connect();
    try {
      const result = await db.query<{ indexdef: string }>(
        `select indexdef from pg_indexes
          where schemaname = 'public' and tablename = 'plays' and indexname = 'plays_ended_at_idx'`,
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]!.indexdef).toMatch(/\(ended_at\)$/);
    } finally {
      await db.end();
    }
  });

  it("accepts a poll row with no ms_played, because the poller does not know the play length", async () => {
    const res = await insertPlays([play(1, { source: "poll", ms_played: null })]);

    expect(res.status).toBe(201);
    await clearPlays();
  });

  it("rejects an export row with no ms_played", async () => {
    const res = await insertPlays([play(1, { source: "export", ms_played: null })]);
    const body = (await res.json()) as { code: string; message: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe("23514");
    expect(body.message).toContain("plays_export_needs_ms");
  });

  it("still rejects a poll row with a negative ms_played", async () => {
    const res = await insertPlays([play(1, { source: "poll", ms_played: -1 })]);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("23514");
  });

  it("stores an export row, a poll row with a length and a poll row with none, and counts all three", async () => {
    expect(
      (
        await insertPlays([
          play(1, { source: "export", ms_played: 5000 }),
          play(2, { source: "poll", ms_played: null }),
          play(3, { source: "poll", ms_played: 200000 }),
        ])
      ).status,
    ).toBe(201);

    expect(await (await getCount()).json()).toEqual({ count: 3 });
  });

  it("accepts a zero ms_played and a missing album", async () => {
    expect((await insertPlays([play(1, { ms_played: 0, album_name: null })])).status).toBe(201);
    await clearPlays();
  });
});

describe.each([
  ["anon key", env.anonKey],
  ["publishable key", env.publishableKey ?? ""],
] as [string, string][])("a browser request with the %s, with plays stored", (_label, key) => {
  const headers = (extra: Record<string, string> = {}) => ({
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra,
  });

  beforeAll(async () => {
    await clearPlays();
    expect((await insertPlays([play(1), play(2)])).status).toBe(201);
  });
  afterAll(clearPlays);

  async function refused(res: Response) {
    const body = (await res.json().catch(() => null)) as { code?: string } | null;
    return res.status === 401 || res.status === 403 || body?.code === "42501";
  }

  it("reads no play", async () => {
    const res = await fetch(`${env.apiUrl}/rest/v1/plays?select=*`, { headers: headers() });
    const body = (await res.json()) as { code?: string; message?: string };

    // The role holds no SELECT privilege, so PostgREST answers 401 with Postgres code 42501.
    expect(res.status).toBe(401);
    expect(body.code).toBe("42501");
    expect(body.message).toBe("permission denied for table plays");
    expect(JSON.stringify(body)).not.toContain("Synthetic");
  });

  it("counts no play", async () => {
    const res = await fetch(`${env.apiUrl}/rest/v1/plays?select=id`, {
      method: "HEAD",
      headers: headers({ Prefer: "count=exact" }),
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("content-range")).toBeNull();
  });

  it("writes no play, with a valid row, an update or a delete", async () => {
    const insert = await fetch(`${env.apiUrl}/rest/v1/plays`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify([play(99)]),
    });
    const update = await fetch(`${env.apiUrl}/rest/v1/plays?id=gte.0`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ track_name: "browser write" }),
    });
    const remove = await fetch(`${env.apiUrl}/rest/v1/plays?id=gte.0`, {
      method: "DELETE",
      headers: headers(),
    });

    expect(await refused(insert)).toBe(true);
    expect(await refused(update)).toBe(true);
    expect(await refused(remove)).toBe(true);

    const rows = await fetch(`${env.apiUrl}/rest/v1/plays?select=track_name,track_uri&order=id`, {
      headers: serviceHeaders(),
    });
    expect(await rows.json()).toEqual([
      { track_name: "Synthetic Track 1", track_uri: "spotify:track:synthetic1" },
      { track_name: "Synthetic Track 2", track_uri: "spotify:track:synthetic2" },
    ]);
  });
});
