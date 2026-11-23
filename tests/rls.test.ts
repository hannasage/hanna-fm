import { Client } from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { testEnv } from "./support/env";

const env = testEnv();
let db: Client;
let tables: string[] = [];

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

beforeAll(async () => {
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
  await db.end();
});

describe("row-level security", () => {
  it("finds at least one public table to check", () => {
    expect(tables).toContain("health_check");
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

  it("gives no browser role any table privilege or policy", async () => {
    const privileges = await db.query(
      `select table_name, grantee, privilege_type
         from information_schema.role_table_grants
        where table_schema = 'public' and grantee in ('anon', 'authenticated', 'PUBLIC')`,
    );
    expect(privileges.rows).toEqual([]);

    const policies = await db.query(
      `select tablename, policyname from pg_policies where schemaname = 'public'`,
    );
    expect(policies.rows).toEqual([]);
  });

  describe.each([
    ["anon key", env.anonKey],
    ...(env.publishableKey ? [["publishable key", env.publishableKey]] : []),
  ] as [string, string][])("a browser request with the %s", (_label, key) => {
    it("reads no rows from any table", async () => {
      for (const table of tables) {
        expect((await serviceRows(table)).length).toBeGreaterThan(0);

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
        const before = await serviceRows(table);
        const json = restHeaders(key, {
          "Content-Type": "application/json",
          Prefer: "return=representation",
        });

        const insert = await fetch(`${env.apiUrl}/rest/v1/${table}`, {
          method: "POST",
          headers: json,
          body: JSON.stringify({ label: "browser write" }),
        });
        const update = await fetch(`${env.apiUrl}/rest/v1/${table}?id=gte.0`, {
          method: "PATCH",
          headers: json,
          body: JSON.stringify({ label: "browser write" }),
        });
        const remove = await fetch(`${env.apiUrl}/rest/v1/${table}?id=gte.0`, {
          method: "DELETE",
          headers: json,
        });

        expect(insert.status).toBeGreaterThanOrEqual(400);
        for (const res of [update, remove]) {
          const body: unknown = await res.json().catch(() => null);
          expect([200, 204, 401, 403]).toContain(res.status);
          if (res.status === 200) expect(body).toEqual([]);
        }
        expect(await serviceRows(table)).toEqual(before);
      }
    });
  });
});
