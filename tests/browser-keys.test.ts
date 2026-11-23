import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { testEnv } from "./support/env";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

describe("the browser holds no database key", () => {
  it("serves a home page that contains no key or database address", async () => {
    const { healthySiteUrl, anonKey, serviceRoleKey, apiUrl, dbUrl } = testEnv();
    const res = await fetch(healthySiteUrl);
    const html = await res.text();

    expect(res.status).toBe(200);
    for (const secret of [anonKey, serviceRoleKey, apiUrl, dbUrl]) {
      expect(html).not.toContain(secret);
    }
  });

  it("never exposes a database variable to the browser", () => {
    const files = sourceFiles(join(process.cwd(), "src"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/NEXT_PUBLIC_\w*(SUPABASE|DATABASE|DB)/i);
    }
  });

  it("keeps the database client in server-only code", () => {
    const client = readFileSync(join(process.cwd(), "src/lib/supabase/server.ts"), "utf8");
    expect(client).toContain('import "server-only"');
  });
});
