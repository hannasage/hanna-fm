import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readSiteLog, testEnv, waitForSiteLog, type SiteName } from "./support/env";

/**
 * Both poller tables start empty: the seed file holds no poller rows. Every row here is
 * synthetic, inserted with the service role, and removed again after the file. Only this
 * file commits rows to them. The route reads the real clock, so each row is placed
 * relative to now.
 */
const env = testEnv();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Outcome = "ok" | "failed";

type Run = {
  started_at: string;
  finished_at: string;
  outcome: Outcome;
  fetched: number | null;
  stored: number | null;
  failure_kind: string | null;
};

/** A run that finished `agoMs` milliseconds ago. */
function run(outcome: Outcome, agoMs: number, kind = "spotify_rate_limited"): Run {
  const finished = Date.now() - agoMs;
  return {
    started_at: new Date(finished - 1_000).toISOString(),
    finished_at: new Date(finished).toISOString(),
    outcome,
    fetched: outcome === "ok" ? 5 : null,
    stored: outcome === "ok" ? 5 : null,
    failure_kind: outcome === "failed" ? kind : null,
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

async function insertRuns(rows: Run[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    const res = await fetch(`${env.apiUrl}/rest/v1/poller_runs`, {
      method: "POST",
      headers: serviceHeaders(),
      body: JSON.stringify(rows.slice(i, i + 500)),
    });
    expect(res.status).toBe(201);
  }
}

async function setState(key: string, value: string): Promise<void> {
  const res = await fetch(`${env.apiUrl}/rest/v1/poller_state?on_conflict=key`, {
    method: "POST",
    headers: serviceHeaders({ Prefer: "resolution=merge-duplicates" }),
    body: JSON.stringify({ key, value }),
  });
  // 201 for a new key, 200 when the upsert replaces one.
  expect([200, 201]).toContain(res.status);
}

async function clearAll() {
  for (const filter of ["poller_runs?id=gte.0", "poller_state?key=not.is.null"]) {
    const res = await fetch(`${env.apiUrl}/rest/v1/${filter}`, {
      method: "DELETE",
      headers: serviceHeaders(),
    });
    expect(res.status).toBe(204);
  }
}

type Status = {
  status: string;
  last_ok_at: string | null;
  last_failure: { at: string; kind: string } | null;
  login: { state: string; days_since_authorized: number | null };
};

async function getStatus(site: SiteName = "healthy", query = "") {
  return fetch(`${env.sites[site]}/api/poller/status${query}`);
}

async function status(): Promise<Status> {
  const res = await getStatus();
  expect(res.status).toBe(200);
  return (await res.json()) as Status;
}

/** The same instant, written the way the route writes it. */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

beforeAll(clearAll);
afterAll(clearAll);
beforeEach(clearAll);

describe("GET /api/poller/status: the tables are empty", () => {
  it("reports no_runs, no failure and an unknown login", async () => {
    const res = await getStatus();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "no_runs",
      last_ok_at: null,
      last_failure: null,
      login: { state: "unknown", days_since_authorized: null },
    });
  });

  it("can be cached for a minute by a shared cache", async () => {
    const res = await getStatus();

    expect(res.headers.get("cache-control")).toBe("public, s-maxage=60");
  });
});

describe("GET /api/poller/status: run status", () => {
  it("reports ok with the time of the newest ok run", async () => {
    const newest = run("ok", 10 * MINUTE);
    await insertRuns([run("ok", 50 * MINUTE), newest]);

    const body = await status();

    expect(body.status).toBe("ok");
    expect(body.last_ok_at).toBe(newest.finished_at);
    expect(body.last_failure).toBeNull();
  });

  it("reports ok for an ok run a little under two hours old", async () => {
    await insertRuns([run("ok", 2 * HOUR - 2 * MINUTE)]);

    expect((await status()).status).toBe("ok");
  });

  it("reports stale for an ok run a little over two hours old", async () => {
    const old = run("ok", 2 * HOUR + 2 * MINUTE);
    await insertRuns([old]);

    const body = await status();

    expect(body.status).toBe("stale");
    expect(body.last_ok_at).toBe(old.finished_at);
    expect(body.last_failure).toBeNull();
  });

  it("reports failing when the most recent run failed, and still gives the last ok time", async () => {
    const ok = run("ok", 20 * MINUTE);
    const failed = run("failed", 5 * MINUTE, "spotify_unauthorized");
    await insertRuns([ok, failed]);

    const body = await status();

    expect(body.status).toBe("failing");
    expect(body.last_ok_at).toBe(ok.finished_at);
    expect(body.last_failure).toEqual({ at: failed.finished_at, kind: "spotify_unauthorized" });
  });

  it("reports failing, not stale, when the last ok run is old and the latest run failed", async () => {
    await insertRuns([run("ok", 5 * HOUR), run("failed", 1 * MINUTE)]);

    expect((await status()).status).toBe("failing");
  });

  it("reports failing with no ok time when no run ever succeeded", async () => {
    const failed = run("failed", 3 * MINUTE, "database_unreachable");
    await insertRuns([failed]);

    const body = await status();

    expect(body.status).toBe("failing");
    expect(body.last_ok_at).toBeNull();
    expect(body.last_failure).toEqual({ at: failed.finished_at, kind: "database_unreachable" });
  });

  it("goes back to ok after a success, and keeps the earlier failure as the last failure", async () => {
    const failed = run("failed", 30 * MINUTE, "spotify_timeout");
    await insertRuns([failed, run("ok", 5 * MINUTE)]);

    const body = await status();

    expect(body.status).toBe("ok");
    expect(body.last_failure).toEqual({ at: failed.finished_at, kind: "spotify_timeout" });
  });

  it("picks the most recent failure by finish time, not by the order rows were stored", async () => {
    const newest = run("failed", 10 * MINUTE, "newest_failure");
    // The newer failure is stored first, so its id is the lower one.
    await insertRuns([newest, run("failed", 90 * MINUTE, "older_failure")]);

    const body = await status();

    expect(body.last_failure).toEqual({ at: newest.finished_at, kind: "newest_failure" });
  });

  it("picks the latest run by finish time when an older run was stored last", async () => {
    // The failed run finished after the ok run, though it was stored first.
    await insertRuns([run("failed", 5 * MINUTE), run("ok", 6 * MINUTE)]);

    expect((await status()).status).toBe("failing");
  });

  it("accepts the longest failure kind", async () => {
    const kind = `k${"0".repeat(63)}`;
    await insertRuns([run("failed", MINUTE, kind)]);

    expect((await status()).last_failure?.kind).toBe(kind);
  });

  it("answers right with more rows than the API row limit of 1000", async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => run("ok", (i + 10) * MINUTE));
    await insertRuns(rows);
    await insertRuns([run("failed", 2 * HOUR * 24, "old_failure")]);

    const body = await status();

    expect(body.status).toBe("ok");
    expect(body.last_ok_at).toBe(rows[0]!.finished_at);
    expect(body.last_failure?.kind).toBe("old_failure");
  });
});

describe("GET /api/poller/status: login", () => {
  async function loginFor(value: string | null) {
    if (value !== null) await setState("spotify_authorized_at", value);
    return (await status()).login;
  }

  it("is unknown when the key is absent", async () => {
    expect(await loginFor(null)).toEqual({ state: "unknown", days_since_authorized: null });
  });

  it("ignores other keys", async () => {
    await setState("some_other_key", iso(Date.now() - 200 * DAY));

    expect((await status()).login).toEqual({ state: "unknown", days_since_authorized: null });
  });

  it.each<[number, string, number]>([
    [0, "ok", 0],
    [1, "ok", 1],
    [149, "ok", 149],
    [150, "expiring", 150],
    [151, "expiring", 151],
    [179, "expiring", 179],
    [180, "expired", 180],
    [181, "expired", 181],
    [400, "expired", 400],
  ])("reads an instant %i days ago as %s, %i days", async (days, state, counted) => {
    const login = await loginFor(iso(Date.now() - days * DAY));

    expect(login).toEqual({ state, days_since_authorized: counted });
  });

  it.each<[number, string]>([
    [149, "ok"],
    [150, "expiring"],
    [179, "expiring"],
    [180, "expired"],
  ])("reads a date %i days ago as %s", async (days, state) => {
    // A date alone means midnight UTC, so a date N days back is at least N days old.
    const day = new Date(Date.now() - days * DAY).toISOString().slice(0, 10);

    const login = await loginFor(day);

    expect(login.state).toBe(state);
    expect(login.days_since_authorized).toBe(days);
  });

  it("reads an instant with a UTC offset", async () => {
    const instant = new Date(Date.now() - 160 * DAY - HOUR);
    // The same instant written two hours ahead of UTC.
    const local = new Date(instant.getTime() + 2 * HOUR).toISOString().slice(0, 19);

    const login = await loginFor(`${local}+02:00`);

    expect(login).toEqual({ state: "expiring", days_since_authorized: 160 });
  });

  it("reads an instant just under 150 days old as ok and just over as expiring", async () => {
    expect((await loginFor(iso(Date.now() - 150 * DAY + 5 * MINUTE))).state).toBe("ok");
    expect((await loginFor(iso(Date.now() - 150 * DAY - 5 * MINUTE))).state).toBe("expiring");
  });

  it("reads an instant just under 180 days old as expiring and just over as expired", async () => {
    expect((await loginFor(iso(Date.now() - 180 * DAY + 5 * MINUTE))).state).toBe("expiring");
    expect((await loginFor(iso(Date.now() - 180 * DAY - 5 * MINUTE))).state).toBe("expired");
  });

  it("reads a future date as unknown", async () => {
    expect(await loginFor(iso(Date.now() + 3 * DAY))).toEqual({
      state: "unknown",
      days_since_authorized: null,
    });
  });

  it("reads a future calendar day as unknown", async () => {
    const later = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10);

    expect(await loginFor(later)).toEqual({ state: "unknown", days_since_authorized: null });
  });

  it.each(["", "soon", "2026-13-45", "2026-02-30", "1700000000", "yesterday", "  ", "2026-1-5", "NaN", "{}"])(
    "reads the unreadable value %j as unknown",
    async (value) => {
      expect(await loginFor(value)).toEqual({ state: "unknown", days_since_authorized: null });
    },
  );

  it("changes when the stored date changes", async () => {
    expect((await loginFor(iso(Date.now() - 10 * DAY))).state).toBe("ok");
    expect((await loginFor(iso(Date.now() - 170 * DAY))).state).toBe("expiring");
  });
});

describe("GET /api/poller/status: what the caller sees", () => {
  it("holds exactly the documented fields and no other", async () => {
    await insertRuns([run("ok", 20 * MINUTE), run("failed", 5 * MINUTE)]);
    await setState("spotify_authorized_at", iso(Date.now() - 160 * DAY));

    const body = (await (await getStatus()).json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(["last_failure", "last_ok_at", "login", "status"]);
    expect(Object.keys(body.last_failure as object).sort()).toEqual(["at", "kind"]);
    expect(Object.keys(body.login as object).sort()).toEqual(["days_since_authorized", "state"]);
    expect(Number.isInteger((body.login as Status["login"]).days_since_authorized)).toBe(true);
  });

  it("never shows a stored value that is not one of the documented fields", async () => {
    await insertRuns([run("ok", 5 * MINUTE)]);
    await setState("spotify_authorized_at", iso(Date.now() - 160 * DAY));
    await setState("spotify_refresh_token", "synthetic-secret-sentinel");
    await setState("spotify_authorized_at_note", "synthetic-note-sentinel");

    const text = await (await getStatus()).text();

    expect(text).not.toContain("synthetic-secret-sentinel");
    expect(text).not.toContain("synthetic-note-sentinel");
    expect(text).not.toMatch(/token|secret|password|key/i);
    for (const { value } of env.secrets) expect(text.includes(value)).toBe(false);
  });

  it("logs nothing on the healthy site", async () => {
    await getStatus();

    expect(readSiteLog("healthy")).not.toContain("poller status failed");
  });
});

describe("GET /api/poller/status: query parameters", () => {
  it.each([
    "?x=1",
    "?now=2026-01-01T00:00:00Z",
    "?p_now=2026-01-01T00:00:00Z",
    "?status=ok",
    "?stale_after_hours=999",
    "?=",
    "?%00=1",
  ])("refuses %s with 400", async (query) => {
    await insertRuns([run("ok", 5 * HOUR)]);

    const res = await getStatus("healthy", query);

    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toEqual({ status: "bad_request" });
  });

  it("answers an empty query string as a plain request", async () => {
    expect((await getStatus("healthy", "?")).status).toBe(200);
  });

  it("cannot be moved by a caller who tries to set the clock", async () => {
    await insertRuns([run("ok", 5 * HOUR)]);

    const plain = (await (await getStatus("healthy", "")).json()) as Status;
    const tried = await getStatus("healthy", `?now=${encodeURIComponent(iso(Date.now() - 6 * HOUR))}`);

    expect(plain.status).toBe("stale");
    expect(tried.status).toBe(400);
    expect(await tried.json()).toEqual({ status: "bad_request" });
  });

  it("answers 400 even when the database is down", async () => {
    const res = await getStatus("refused", "?x=1");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ status: "bad_request" });
  });
});

describe("GET /api/poller/status: when the database fails", () => {
  describe.each<[string, SiteName, string]>([
    ["the database refuses the connection", "refused", "name=TypeError code=ECONNREFUSED"],
    ["the database never answers", "hanging", "name=TimeoutError code=none"],
    ["the database rejects the key (PostgREST 401)", "badKey", "name=PostgrestError code=PGRST301"],
    ["a database variable is missing", "missingEnv", "name=ServerConfigError code=SERVER_ENV_MISSING"],
    [
      "the database answers in a shape the site does not expect",
      "malformed",
      "name=PollerStatusShapeError code=POLLER_SHAPE",
    ],
  ])("when %s", (_label, site, reason) => {
    it("answers 503 with the same unhealthy body and no cache", async () => {
      const started = Date.now();
      const res = await getStatus(site);

      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(await res.json()).toEqual({ status: "unhealthy" });
      expect(Date.now() - started).toBeLessThan(8_000);
    });

    it("logs a sanitized reason on the server", async () => {
      await getStatus(site);
      const log = await waitForSiteLog(site, "poller status failed");

      expect(log).toContain(`poller status failed: ${reason}`);
    });

    it("leaks no secret, address or message to the caller or the log", async () => {
      const res = await getStatus(site);
      const body = await res.text();
      const log = await waitForSiteLog(site, "poller status failed");

      const leaked = env.secrets
        .filter(({ value }) => body.includes(value) || log.includes(value))
        .map(({ name }) => name);
      expect(leaked).toEqual([]);
      expect(body.includes("not-a-real-key") || log.includes("not-a-real-key")).toBe(false);
      expect((body + log).includes(new URL(env.apiUrl).host)).toBe(false);
      expect(/fetch failed|Expected 3 parts|Caused by|not-a-date/i.test(body + log)).toBe(false);
    });
  });
});

describe("the routes that were already there", () => {
  it("still answer while poller rows exist", async () => {
    await insertRuns([run("ok", 5 * MINUTE), run("failed", MINUTE)]);
    await setState("spotify_authorized_at", iso(Date.now() - 10 * DAY));

    const health = await fetch(`${env.sites.healthy}/api/health`);
    const count = await fetch(`${env.sites.healthy}/api/plays/count`);

    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "healthy" });
    expect(count.status).toBe(200);
    expect(await count.json()).toEqual({ count: expect.any(Number) });
  });
});

describe("the poller tables", () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: env.dbUrl });
    await db.connect();
  });

  afterAll(async () => {
    await db?.end();
  });

  const TABLES = ["poller_runs", "poller_state"];

  it("exist in public, with row-level security enabled and forced", async () => {
    const result = await db.query<{ relname: string; on: boolean; forced: boolean }>(
      `select c.relname, c.relrowsecurity as on, c.relforcerowsecurity as forced
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any($1) order by 1`,
      [TABLES],
    );

    expect(result.rows).toEqual([
      { relname: "poller_runs", on: true, forced: true },
      { relname: "poller_state", on: true, forced: true },
    ]);
  });

  it.each(TABLES)("%s grants nothing to anon, authenticated or PUBLIC", async (table) => {
    const effective = await db.query(
      `select r.role from (values ('anon'), ('authenticated')) as r(role)
        where has_table_privilege(r.role, 'public.${table}',
                'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
           or has_any_column_privilege(r.role, 'public.${table}', 'SELECT,INSERT,UPDATE,REFERENCES')`,
    );
    const listed = await db.query(
      `select case a.grantee when 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee
         from pg_class c join pg_namespace n on n.oid = c.relnamespace,
              lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
        where n.nspname = 'public' and c.relname = $1
          and (a.grantee = 0 or a.grantee::regrole::text in ('anon', 'authenticated'))`,
      [table],
    );

    expect(effective.rows).toEqual([]);
    expect(listed.rows).toEqual([]);
  });

  it.each(TABLES)("%s refuses an anon-key request with 42501", async (table) => {
    const headers = {
      apikey: env.anonKey,
      Authorization: `Bearer ${env.anonKey}`,
      "Content-Type": "application/json",
    };

    const read = await fetch(`${env.apiUrl}/rest/v1/${table}?select=*`, { headers });
    const write = await fetch(`${env.apiUrl}/rest/v1/${table}`, {
      method: "POST",
      headers,
      body: JSON.stringify(table === "poller_runs" ? run("ok", MINUTE) : { key: "k", value: "v" }),
    });

    expect(((await read.json()) as { code?: string }).code).toBe("42501");
    expect(((await write.json()) as { code?: string }).code).toBe("42501");
  });

  it("reject a run that finishes before it starts, an unknown outcome, or a mismatched failure kind", async () => {
    const bad: Partial<Run>[] = [
      { finished_at: iso(Date.now() - 10 * MINUTE), started_at: iso(Date.now()) },
      { outcome: "weird" as Outcome },
      { outcome: "ok", failure_kind: "x" },
      { outcome: "failed", failure_kind: null },
      { outcome: "failed", failure_kind: "Has Spaces And Capitals" },
    ];
    for (const patch of bad) {
      const res = await fetch(`${env.apiUrl}/rest/v1/poller_runs`, {
        method: "POST",
        headers: serviceHeaders(),
        body: JSON.stringify({ ...run("ok", MINUTE), ...patch }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("23514");
    }
  });
});
