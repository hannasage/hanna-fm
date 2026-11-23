import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testEnv } from "./support/env";

/**
 * The items, mb_cache and job_locks tables, checked in the database and at the HTTP door.
 * Every row is synthetic. Database checks run inside a transaction that rolls back, so no
 * row is ever committed and no other test file sees one.
 */
const env = testEnv();
const TABLES = ["items", "mb_cache", "job_locks"] as const;
const SEQUENCES = ["items_id_seq"] as const;

let db: Client;

beforeAll(async () => {
  db = new Client({ connectionString: env.dbUrl });
  await db.connect();
});

afterAll(async () => {
  await db?.end();
});

/** Runs the body in a transaction and always rolls it back. */
async function rolledBack<T>(body: () => Promise<T>): Promise<T> {
  await db.query("begin");
  try {
    return await body();
  } finally {
    await db.query("rollback");
  }
}

/** Runs one statement in a savepoint, so a refused row does not end the transaction. */
async function attempt(sql: string, values: unknown[] = []): Promise<{ code?: string }> {
  await db.query("savepoint attempt");
  try {
    await db.query(sql, values);
    await db.query("release savepoint attempt");
    return {};
  } catch (error) {
    await db.query("rollback to savepoint attempt");
    return { code: (error as { code?: string }).code };
  }
}

const UNIQUE = "23505";
const CHECK = "23514";
const FOREIGN_KEY = "23503";

const MBID_A = "00000000-0000-4000-8000-00000000000a";
const MBID_B = "00000000-0000-4000-8000-00000000000b";
const NOW_SQL = "sql:now()";

/**
 * Inserts one synthetic item. `columns` is a map of column name to a SQL expression or a
 * plain value; a string that starts with "sql:" is written as SQL.
 */
function insertItem(columns: Record<string, string | number | null>) {
  const names = Object.keys(columns);
  const values: unknown[] = [];
  const marks = names.map((name) => {
    const value = columns[name];
    if (typeof value === "string" && value.startsWith("sql:")) return value.slice(4);
    values.push(value);
    return `$${values.length}`;
  });
  return { sql: `insert into public.items (${names.join(", ")}) values (${marks.join(", ")}) returning id`, values };
}

async function addItem(columns: Record<string, string | number | null>): Promise<number> {
  const { sql, values } = insertItem(columns);
  const result = await db.query<{ id: string }>(sql, values);
  return Number(result.rows[0]!.id);
}

async function tryItem(columns: Record<string, string | number | null>) {
  const { sql, values } = insertItem(columns);
  return attempt(sql, values);
}

const pendingTrack = (n: number) => ({
  kind: "track",
  name: `Synthetic Track ${n}`,
  source_key: `spotify:track:synthetic${n}`,
});

describe("the tables", () => {
  it("exist in public: items, mb_cache and job_locks", async () => {
    const result = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname = any($1) order by 1`,
      [[...TABLES]],
    );
    expect(result.rows.map((r) => r.relname)).toEqual([...TABLES].sort());
  });

  it("have row-level security enabled and forced", async () => {
    const result = await db.query<{ relname: string; on: boolean; forced: boolean }>(
      `select c.relname, c.relrowsecurity as on, c.relforcerowsecurity as forced
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any($1) order by 1`,
      [[...TABLES]],
    );
    expect(result.rows).toEqual(
      [...TABLES].sort().map((relname) => ({ relname, on: true, forced: true })),
    );
  });

  it("have no policy", async () => {
    const result = await db.query(
      `select tablename from pg_policies where schemaname = 'public' and tablename = any($1)`,
      [[...TABLES]],
    );
    expect(result.rows).toEqual([]);
  });
});

describe("privileges", () => {
  const PRIVS = "SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER";

  it.each(["anon", "authenticated"])("%s holds nothing on the tables or their columns", async (role) => {
    for (const table of TABLES) {
      const held = await db.query<{ table: boolean; column: boolean }>(
        `select has_table_privilege($1, $2::regclass, '${PRIVS}') as "table",
                has_any_column_privilege($1, $2::regclass, 'SELECT,INSERT,UPDATE,REFERENCES') as "column"`,
        [role, `public.${table}`],
      );
      expect(held.rows[0], `${role} on ${table}`).toEqual({ table: false, column: false });
    }
  });

  it.each(["anon", "authenticated"])("%s holds nothing on the sequences", async (role) => {
    for (const sequence of SEQUENCES) {
      const held = await db.query<{ held: boolean }>(
        `select has_sequence_privilege($1, $2::regclass, 'USAGE,SELECT,UPDATE') as held`,
        [role, `public.${sequence}`],
      );
      expect(held.rows[0]!.held, `${role} on ${sequence}`).toBe(false);
    }
  });

  it("PUBLIC holds nothing in any access list of the tables or sequences", async () => {
    const result = await db.query(
      `select c.relname, a.privilege_type
         from pg_class c join pg_namespace n on n.oid = c.relnamespace,
              lateral aclexplode(coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))) a
        where n.nspname = 'public' and c.relname = any($1) and a.grantee = 0`,
      [[...TABLES, ...SEQUENCES]],
    );
    expect(result.rows).toEqual([]);
  });

  it("the migration role still reaches the tables", async () => {
    await rolledBack(async () => {
      await addItem(pendingTrack(1));
      const count = await db.query<{ n: string }>("select count(*) as n from public.items");
      expect(Number(count.rows[0]!.n)).toBe(1);
    });
  });
});

describe.each([
  ["anon key", () => env.anonKey],
  ["publishable key", () => env.publishableKey ?? ""],
] as [string, () => string][])("a browser request with the %s", (_label, getKey) => {
  const headers = (extra: Record<string, string> = {}) => ({
    apikey: getKey(),
    Authorization: `Bearer ${getKey()}`,
    "Content-Type": "application/json",
    ...extra,
  });

  const probes: [string, Record<string, unknown>, string][] = [
    [
      "items",
      { kind: "track", name: "browser write", source_key: "browser-write" },
      "id=gte.0",
    ],
    [
      "mb_cache",
      { request_hash: "0".repeat(64), candidates: [] },
      "request_hash=not.is.null",
    ],
    ["job_locks", { name: "browser-write" }, "name=not.is.null"],
  ];

  it("has a key to send", () => {
    expect(getKey().length).toBeGreaterThan(0);
  });

  it.each(probes)("is refused with 42501 on every read and write of %s", async (table, row, filter) => {
    const url = `${env.apiUrl}/rest/v1/${table}`;
    const calls: [string, Response][] = [
      ["select", await fetch(`${url}?select=*`, { headers: headers() })],
      ["insert", await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(row) })],
      ["update", await fetch(`${url}?${filter}`, { method: "PATCH", headers: headers(), body: JSON.stringify(row) })],
      ["delete", await fetch(`${url}?${filter}`, { method: "DELETE", headers: headers() })],
    ];
    for (const [what, res] of calls) {
      const body = (await res.json().catch(() => null)) as { code?: string } | null;
      expect(body?.code, `${what} on ${table}: status ${res.status}`).toBe("42501");
    }
  });
});

describe("items constraints", () => {
  it("accepts a pending item with defaults", async () => {
    await rolledBack(async () => {
      const id = await addItem(pendingTrack(1));
      const row = await db.query(
        "select state, attempts, resolved_at, mbid, reason from public.items where id = $1",
        [id],
      );
      expect(row.rows[0]).toEqual({ state: "pending", attempts: 0, resolved_at: null, mbid: null, reason: null });
    });
  });

  it("refuses an unknown kind, state or reason", async () => {
    await rolledBack(async () => {
      expect((await tryItem({ ...pendingTrack(1), kind: "playlist" })).code).toBe(CHECK);
      expect((await tryItem({ ...pendingTrack(2), state: "done" })).code).toBe(CHECK);
      expect(
        (await tryItem({ ...pendingTrack(3), state: "unresolved", reason: "because", resolved_at: NOW_SQL })).code,
      ).toBe(CHECK);
    });
  });

  it("refuses a null name, a null source key and a negative attempt count", async () => {
    await rolledBack(async () => {
      expect((await tryItem({ kind: "track", name: null, source_key: "k1" })).code).toBe("23502");
      expect((await tryItem({ kind: "track", name: "n", source_key: null })).code).toBe("23502");
      expect((await tryItem({ ...pendingTrack(1), attempts: -1 })).code).toBe(CHECK);
    });
  });

  describe("unique kind and source key", () => {
    it("refuses a second item with the same kind and source key", async () => {
      await rolledBack(async () => {
        await addItem(pendingTrack(1));
        expect((await tryItem(pendingTrack(1))).code).toBe(UNIQUE);
      });
    });

    it("allows the same source key under another kind", async () => {
      await rolledBack(async () => {
        await addItem({ kind: "artist", name: "Synthetic", source_key: "synthetic" });
        expect((await tryItem({ kind: "album", name: "Synthetic", source_key: "synthetic" })).code).toBeUndefined();
      });
    });
  });

  describe("unique kind and mbid where mbid is set", () => {
    const resolved = (n: number, mbid: string) => ({
      ...pendingTrack(n),
      state: "resolved",
      mbid,
      resolved_at: NOW_SQL,
    });

    it("refuses two items of one kind with the same mbid", async () => {
      await rolledBack(async () => {
        await addItem(resolved(1, MBID_A));
        expect((await tryItem(resolved(2, MBID_A))).code).toBe(UNIQUE);
      });
    });

    it("allows the same mbid under another kind", async () => {
      await rolledBack(async () => {
        await addItem(resolved(1, MBID_A));
        const other = { ...resolved(2, MBID_A), kind: "album" };
        expect((await tryItem(other)).code).toBeUndefined();
      });
    });

    it("allows many items of one kind with no mbid", async () => {
      await rolledBack(async () => {
        await addItem(pendingTrack(1));
        expect((await tryItem(pendingTrack(2))).code).toBeUndefined();
        expect((await tryItem(pendingTrack(3))).code).toBeUndefined();
      });
    });

    it("refuses a malformed mbid", async () => {
      await rolledBack(async () => {
        expect((await tryItem({ ...resolved(1, "not-a-uuid") })).code).toBe("22P02");
      });
    });
  });

  describe("resolved items need an mbid or a merge target", () => {
    it("refuses a resolved item with neither", async () => {
      await rolledBack(async () => {
        const result = await tryItem({ ...pendingTrack(1), state: "resolved", resolved_at: NOW_SQL });
        expect(result.code).toBe(CHECK);
      });
    });

    it("refuses a pending item that holds an mbid", async () => {
      await rolledBack(async () => {
        expect((await tryItem({ ...pendingTrack(1), mbid: MBID_A })).code).toBe(CHECK);
      });
    });

    it("refuses an unresolved item that holds an mbid", async () => {
      await rolledBack(async () => {
        const result = await tryItem({
          ...pendingTrack(1),
          state: "unresolved",
          reason: "no_match",
          mbid: MBID_A,
          resolved_at: NOW_SQL,
        });
        expect(result.code).toBe(CHECK);
      });
    });

    it("accepts a resolved item with an mbid, and one with a merge target and no mbid", async () => {
      await rolledBack(async () => {
        const first = await addItem({ ...pendingTrack(1), state: "resolved", mbid: MBID_A, resolved_at: NOW_SQL });
        const second = await tryItem({
          ...pendingTrack(2),
          state: "resolved",
          merged_into: first,
          resolved_at: NOW_SQL,
        });
        expect(second.code).toBeUndefined();
      });
    });

    it("refuses an item that holds both an mbid and a merge target", async () => {
      await rolledBack(async () => {
        const first = await addItem({ ...pendingTrack(1), state: "resolved", mbid: MBID_A, resolved_at: NOW_SQL });
        const result = await tryItem({
          ...pendingTrack(2),
          state: "resolved",
          mbid: MBID_B,
          merged_into: first,
          resolved_at: NOW_SQL,
        });
        expect(result.code).toBe(CHECK);
      });
    });
  });

  describe("merged_into", () => {
    it("refuses a target of another kind", async () => {
      await rolledBack(async () => {
        const artist = await addItem({
          kind: "artist",
          name: "Synthetic",
          source_key: "synthetic",
          state: "resolved",
          mbid: MBID_A,
          resolved_at: NOW_SQL,
        });
        const result = await tryItem({
          ...pendingTrack(1),
          state: "resolved",
          merged_into: artist,
          resolved_at: NOW_SQL,
        });
        expect(result.code).toBe(FOREIGN_KEY);
      });
    });

    it("refuses a target that does not exist", async () => {
      await rolledBack(async () => {
        const result = await tryItem({
          ...pendingTrack(1),
          state: "resolved",
          merged_into: 999999999,
          resolved_at: NOW_SQL,
        });
        expect(result.code).toBe(FOREIGN_KEY);
      });
    });

    it("refuses a row that points at itself", async () => {
      await rolledBack(async () => {
        const id = await addItem(pendingTrack(1));
        const result = await attempt(
          `update public.items set state = 'resolved', merged_into = id, resolved_at = now() where id = $1`,
          [id],
        );
        expect(result.code).toBe(CHECK);
      });
    });
  });

  describe("reason", () => {
    it("is refused on a pending row", async () => {
      await rolledBack(async () => {
        expect((await tryItem({ ...pendingTrack(1), reason: "no_match" })).code).toBe(CHECK);
      });
    });

    it("is accepted on an unresolved row, for every listed reason", async () => {
      await rolledBack(async () => {
        const reasons = [
          "no_match", "below_threshold", "empty_name", "ambiguous", "no_artist", "bad_query", "name_too_long",
        ];
        for (const [i, reason] of reasons.entries()) {
          const result = await tryItem({ ...pendingTrack(i), state: "unresolved", reason, resolved_at: NOW_SQL });
          expect(result.code, reason).toBeUndefined();
        }
      });
    });

    it("is refused on a resolved row, except credit on a resolved artist", async () => {
      await rolledBack(async () => {
        const artist = { kind: "artist", name: "Synthetic", state: "resolved", resolved_at: NOW_SQL };
        expect(
          (await tryItem({ ...artist, source_key: "a1", mbid: MBID_A, reason: "no_match" })).code,
        ).toBe(CHECK);
        expect(
          (await tryItem({ ...artist, source_key: "a2", mbid: MBID_A, reason: "credit" })).code,
        ).toBeUndefined();
      });
    });

    it("refuses credit on a resolved track or album, and on a pending row", async () => {
      await rolledBack(async () => {
        const resolvedTrack = { ...pendingTrack(1), state: "resolved", mbid: MBID_A, resolved_at: NOW_SQL };
        expect((await tryItem({ ...resolvedTrack, reason: "credit" })).code).toBe(CHECK);
        const resolvedAlbum = { ...resolvedTrack, kind: "album", source_key: "al1" };
        expect((await tryItem({ ...resolvedAlbum, reason: "credit" })).code).toBe(CHECK);
        expect((await tryItem({ ...pendingTrack(2), reason: "credit" })).code).toBe(CHECK);
      });
    });

    it("accepts credit on an unresolved row", async () => {
      await rolledBack(async () => {
        const result = await tryItem({ ...pendingTrack(1), state: "unresolved", reason: "credit", resolved_at: NOW_SQL });
        expect(result.code).toBeUndefined();
      });
    });
  });

  describe("resolved_at", () => {
    it("is refused on a pending row", async () => {
      await rolledBack(async () => {
        expect((await tryItem({ ...pendingTrack(1), resolved_at: NOW_SQL })).code).toBe(CHECK);
      });
    });

    it("is required on an unresolved row", async () => {
      await rolledBack(async () => {
        const result = await tryItem({ ...pendingTrack(1), state: "unresolved", reason: "no_match" });
        expect(result.code).toBe(CHECK);
      });
    });
  });

  describe("match_score", () => {
    it.each([0, 50, 100])("accepts %s", async (score) => {
      await rolledBack(async () => {
        expect((await tryItem({ ...pendingTrack(1), match_score: score })).code).toBeUndefined();
      });
    });

    it.each([-1, 101])("refuses %s", async (score) => {
      await rolledBack(async () => {
        expect((await tryItem({ ...pendingTrack(1), match_score: score })).code).toBe(CHECK);
      });
    });
  });
});

describe("mb_cache constraints", () => {
  const insertCache = (hash: string) =>
    attempt(`insert into public.mb_cache (request_hash, candidates) values ($1, '[]'::jsonb)`, [hash]);

  it("accepts a 64 character lower-case hex hash and fills fetched_at", async () => {
    await rolledBack(async () => {
      expect((await insertCache("a".repeat(32) + "0123456789".repeat(3) + "ab")).code).toBeUndefined();
      const row = await db.query<{ set: boolean }>("select fetched_at is not null as set from public.mb_cache");
      expect(row.rows).toEqual([{ set: true }]);
    });
  });

  it.each([
    ["too short", "a".repeat(63)],
    ["too long", "a".repeat(65)],
    ["upper case", "A".repeat(64)],
    ["not hex", "g".repeat(64)],
    ["empty", ""],
    ["a newline at the end", "a".repeat(63) + "\n"],
  ])("refuses a hash that is %s", async (_label, hash) => {
    await rolledBack(async () => {
      expect((await insertCache(hash)).code).toBe(CHECK);
    });
  });

  it("refuses a second row with the same hash and a null candidates value", async () => {
    await rolledBack(async () => {
      expect((await insertCache("b".repeat(64))).code).toBeUndefined();
      expect((await insertCache("b".repeat(64))).code).toBe(UNIQUE);
      const nullCandidates = await attempt(
        `insert into public.mb_cache (request_hash, candidates) values ($1, null)`,
        ["c".repeat(64)],
      );
      expect(nullCandidates.code).toBe("23502");
    });
  });
});

describe("job_locks constraints", () => {
  it("holds one row per job name, with locked_until empty by default", async () => {
    await rolledBack(async () => {
      expect((await attempt(`insert into public.job_locks (name) values ('synthetic-job')`)).code).toBeUndefined();
      expect((await attempt(`insert into public.job_locks (name) values ('synthetic-job')`)).code).toBe(UNIQUE);
      const row = await db.query("select locked_until from public.job_locks where name = 'synthetic-job'");
      expect(row.rows).toEqual([{ locked_until: null }]);
    });
  });
});

describe("the rest of the site, with the new tables in place", () => {
  it("still counts plays", async () => {
    const res = await fetch(`${env.sites.healthy}/api/plays/count`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ count: expect.any(Number) });
  });

  it("still serves the weekly chart", async () => {
    const res = await fetch(`${env.sites.healthy}/api/charts/weekly?kind=track`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: "track", rows: expect.any(Array) });
  });
});
