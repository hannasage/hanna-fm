import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testEnv } from "./support/env";

const env = testEnv();
let db: Client;
let tables: string[] = [];

/** Schemas the browser's API door can reach. */
const SCHEMAS = ["public", "graphql_public"];

/**
 * Grants that are allowed on purpose. Each one needs a reason and a behavior check below.
 * `graphql_public.graphql` is installed with the GraphQL extension and runs with the
 * caller's own rights, so with no table privilege it shows no table.
 */
const ALLOWED_FUNCTION_EXECUTE = ["graphql_public.graphql"];

const RELKINDS = "('r','p','v','m','f','S')";

/** Privileges anon, authenticated or PUBLIC hold on relations, by effective check. */
const EFFECTIVE_RELATION_PRIVILEGES = `
  select n.nspname || '.' || c.relname as object, c.relkind::text as kind, r.role
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('authenticated')) as r(role)
   where n.nspname = any($1) and c.relkind in ${RELKINDS}
     and (case when c.relkind = 'S'
               then has_sequence_privilege(r.role, c.oid, 'USAGE,SELECT,UPDATE')
               else has_table_privilege(r.role, c.oid,
                      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                 or has_any_column_privilege(r.role, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
          end)
   order by 1, 3`;

/** Grants written in the access list of a relation, function or schema. NULL means the default. */
const ACCESS_LIST_GRANTS = `
  select * from (
    select n.nspname || '.' || c.relname as object, 'relation' as kind,
           case a.grantee when 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee,
           a.privilege_type
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace,
      lateral aclexplode(coalesce(c.relacl,
                acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))) a
     where n.nspname = any($1) and c.relkind in ${RELKINDS}
    union all
    select n.nspname || '.' || p.proname, 'function',
           case a.grantee when 0 then 'PUBLIC' else a.grantee::regrole::text end,
           a.privilege_type
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace,
      lateral aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
     where n.nspname = any($1)
  ) grants
  where grantee in ('PUBLIC', 'anon', 'authenticated')
  order by 1, 3, 4`;

const EFFECTIVE_FUNCTION_PRIVILEGES = `
  select n.nspname || '.' || p.proname as object, r.role
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join (values ('anon'), ('authenticated')) as r(role)
   where n.nspname = any($1) and has_function_privilege(r.role, p.oid, 'EXECUTE')
   order by 1, 2`;

const SCHEMA_CREATE = `
  select s.nspname, r.role
    from pg_namespace s
    cross join (values ('anon'), ('authenticated')) as r(role)
   where s.nspname = any($1) and has_schema_privilege(r.role, s.oid, 'CREATE')`;

type Row = Record<string, string>;

async function privilegeOffenders(): Promise<Record<string, Row[]>> {
  const relations = await db.query<Row>(EFFECTIVE_RELATION_PRIVILEGES, [SCHEMAS]);
  const grants = await db.query<Row>(ACCESS_LIST_GRANTS, [SCHEMAS]);
  const functions = await db.query<Row>(EFFECTIVE_FUNCTION_PRIVILEGES, [SCHEMAS]);
  const create = await db.query<Row>(SCHEMA_CREATE, [SCHEMAS]);
  const allowed = new Set(ALLOWED_FUNCTION_EXECUTE);
  return {
    effectiveRelationPrivileges: relations.rows,
    accessListGrants: grants.rows.filter(
      (g) => !(g.kind === "function" && g.privilege_type === "EXECUTE" && allowed.has(g.object!)),
    ),
    effectiveFunctionPrivileges: functions.rows.filter((f) => !allowed.has(f.object!)),
    schemaCreate: create.rows,
  };
}

const NONE = {
  effectiveRelationPrivileges: [],
  accessListGrants: [],
  effectiveFunctionPrivileges: [],
  schemaCreate: [],
};

/**
 * A valid insert row and a valid update for each table. PostgREST checks column names
 * before privileges, so a made-up column would be refused for the wrong reason.
 * A new table needs an entry here, or the write test below fails on purpose.
 */
const WRITE_PROBES: Record<
  string,
  {
    insert: Record<string, unknown>;
    update: Record<string, unknown>;
    /** The row filter for the update and delete calls. Defaults to `id=gte.0`, for tables with an id. */
    filter?: string;
  }
> = {
  health_check: {
    insert: { label: "browser write" },
    update: { label: "browser write" },
  },
  plays: {
    insert: {
      track_uri: "spotify:track:browserwrite",
      track_name: "browser write",
      artist_name: "browser write",
      ended_at: "2026-01-01T00:00:00Z",
      ms_played: 1,
      source: "poll",
    },
    update: { track_name: "browser write" },
  },
  items: {
    insert: { kind: "track", name: "browser write", source_key: "spotify:track:browserwrite" },
    update: { name: "browser write" },
  },
  mb_cache: {
    insert: { request_hash: "0".repeat(64), candidates: [] },
    update: { candidates: [] },
    filter: "request_hash=not.is.null",
  },
  job_locks: {
    insert: { name: "browser-write" },
    update: { locked_until: "2026-01-01T00:00:00Z" },
    filter: "name=not.is.null",
  },
};

function restHeaders(key: string, extra: Record<string, string> = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

async function serviceRows(table: string): Promise<unknown[]> {
  const res = await fetch(`${env.apiUrl}/rest/v1/${table}?select=*`, {
    headers: restHeaders(env.serviceRoleKey),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as unknown[];
}

/** A refusal is 401 or 403, or Postgres code 42501 (insufficient privilege). */
async function expectRefused(res: Response, what: string) {
  const body = (await res.json().catch(() => null)) as { code?: string } | null;
  const refused = res.status === 401 || res.status === 403 || body?.code === "42501";
  expect(refused, `${what} was not refused: status ${res.status}`).toBe(true);
}

beforeAll(async () => {
  if (!env.publishableKey) {
    throw new Error(
      "The Supabase CLI did not report PUBLISHABLE_KEY, so the publishable-key checks cannot run. " +
        "Update the Supabase CLI or the local stack. This suite will not skip them.",
    );
  }
  db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const result = await db.query<{ relname: string }>(
    `select c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
      order by c.relname`,
  );
  tables = result.rows.map((r) => r.relname);
});

afterAll(async () => {
  await db?.end();
});

describe("row-level security", () => {
  it("finds the health_check table, which holds the one fixture row", async () => {
    expect(tables).toContain("health_check");
    expect((await serviceRows("health_check")).length).toBeGreaterThanOrEqual(1);
  });

  it("finds the plays table", () => {
    expect(tables).toContain("plays");
  });

  it("finds the items, mb_cache and job_locks tables", () => {
    expect(tables).toEqual(expect.arrayContaining(["items", "mb_cache", "job_locks"]));
  });

  it("is enabled and forced on every public table", async () => {
    const result = await db.query<{ relname: string }>(
      `select c.relname
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')
          and not (c.relrowsecurity and c.relforcerowsecurity)`,
    );
    expect(result.rows).toEqual([]);
  });

  it("has no policy in public", async () => {
    const policies = await db.query(
      `select tablename, policyname from pg_policies where schemaname = 'public'`,
    );
    expect(policies.rows).toEqual([]);
  });
});

describe("privileges of anon, authenticated and PUBLIC", () => {
  it("hold nothing on any table, view, sequence or function in public and graphql_public", async () => {
    expect(await privilegeOffenders()).toEqual(NONE);
  });

  it("stay empty for objects created later by the migration role", async () => {
    await db.query("begin");
    try {
      await db.query("create table public.zz_probe_table (id int primary key, label text)");
      await db.query("create view public.zz_probe_view as select * from public.zz_probe_table");
      await db.query("create sequence public.zz_probe_seq");
      await db.query(
        "create function public.zz_probe_fn() returns int language sql as 'select 1'",
      );
      expect(await privilegeOffenders()).toEqual(NONE);
    } finally {
      await db.query("rollback");
    }
  });

  it("show no table through the one function that stays open to the browser", async () => {
    const res = await fetch(`${env.apiUrl}/graphql/v1`, {
      method: "POST",
      headers: restHeaders(env.anonKey, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        query: "{ __schema { types { name } } health_checkCollection { edges { node { id } } } }",
      }),
    });
    const text = await res.text();

    expect(/health_?check/i.test(text)).toBe(false);
    expect(text.includes("synthetic fixture row")).toBe(false);
  });
});

describe("the browser roles in the database, with a play stored", () => {
  // The rows are inserted inside a transaction that rolls back, so no other test sees them.
  async function inTransaction(role: string, statement: string, values: unknown[] = []) {
    await db.query("begin");
    try {
      await db.query(
        `insert into public.plays (track_uri, track_name, artist_name, ended_at, ms_played, source)
         values ('spotify:track:synthetic1', 'Synthetic Track 1', 'Synthetic Artist', now(), 1000, 'export')`,
      );
      await db.query(`set local role ${role}`);
      return await db.query(statement, values);
    } finally {
      await db.query("rollback");
    }
  }

  const insertSql = `insert into public.plays (track_uri, track_name, artist_name, ended_at, ms_played, source)
                     values ('spotify:track:synthetic2', 'Synthetic Track 2', 'Synthetic Artist', now(), 1000, 'poll')`;

  it.each(["anon", "authenticated"])("%s cannot read plays", async (role) => {
    await expect(inTransaction(role, "select * from public.plays")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(inTransaction(role, "select count(*) from public.plays")).rejects.toMatchObject({
      code: "42501",
    });
  });

  it.each(["anon", "authenticated"])("%s cannot write plays", async (role) => {
    await expect(inTransaction(role, insertSql)).rejects.toMatchObject({ code: "42501" });
    await expect(
      inTransaction(role, "update public.plays set track_name = 'x'"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(inTransaction(role, "delete from public.plays")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(inTransaction(role, "truncate public.plays")).rejects.toMatchObject({
      code: "42501",
    });
  });
});

describe.each([
  ["anon key", env.anonKey],
  ["publishable key", env.publishableKey ?? ""],
] as [string, string][])("a browser request with the %s", (_label, key) => {
  it("has a key to send", () => {
    expect(key.length).toBeGreaterThan(0);
  });

  it("reads no rows from any table", async () => {
    for (const table of tables) {
      const res = await fetch(`${env.apiUrl}/rest/v1/${table}?select=*`, {
        headers: restHeaders(key),
      });
      const body: unknown = await res.json().catch(() => null);

      expect([200, 401, 403]).toContain(res.status);
      if (res.status === 200) {
        expect(body).toEqual([]);
      }
    }
  });

  it("writes to no table", async () => {
    for (const table of tables) {
      const probe = WRITE_PROBES[table];
      expect(probe, `public.${table} has no entry in WRITE_PROBES`).toBeDefined();
      const before = await serviceRows(table);
      const json = restHeaders(key, {
        "Content-Type": "application/json",
        Prefer: "return=representation",
      });

      const insert = await fetch(`${env.apiUrl}/rest/v1/${table}`, {
        method: "POST",
        headers: json,
        body: JSON.stringify(probe!.insert),
      });
      const filter = probe!.filter ?? "id=gte.0";
      const update = await fetch(`${env.apiUrl}/rest/v1/${table}?${filter}`, {
        method: "PATCH",
        headers: json,
        body: JSON.stringify(probe!.update),
      });
      const remove = await fetch(`${env.apiUrl}/rest/v1/${table}?${filter}`, {
        method: "DELETE",
        headers: json,
      });

      await expectRefused(insert, `insert into ${table}`);
      await expectRefused(update, `update of ${table}`);
      await expectRefused(remove, `delete from ${table}`);
      expect(await serviceRows(table)).toEqual(before);
    }
  });
});
