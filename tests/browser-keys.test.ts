import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { BROWSER_SECRET_NAME, filesUnder, scanFiles, secretsFoundIn } from "./support/leaks";
import { testEnv } from "./support/env";

const root = process.cwd();

function imports(file: string): { specifiers: string[]; isClient: boolean } {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  let isClient = false;
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      specifiers.push(statement.moduleSpecifier.text);
    }
    if (
      ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression) &&
      statement.expression.text === "use client"
    ) {
      isClient = true;
    }
  }
  return { specifiers, isClient };
}

describe("the scanner itself", () => {
  const fake = [{ name: "FAKE_KEY", value: "fake-secret-value-123" }];

  it("finds a planted secret by name and never returns its value", () => {
    const found = secretsFoundIn("before fake-secret-value-123 after", fake);
    expect(found).toEqual(["FAKE_KEY"]);
    expect(JSON.stringify(found).includes(fake[0]!.value)).toBe(false);
  });

  it("finds nothing in clean text", () => {
    expect(secretsFoundIn("nothing here", fake)).toEqual([]);
  });

  it.each([
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_API_KEY",
    "NEXT_PUBLIC_APP_SECRET",
    "NEXT_PUBLIC_AUTH_TOKEN",
    "NEXT_PUBLIC_DATABASE_URL",
    "NEXT_PUBLIC_DB_URL",
    "next_public_service_key",
  ])("flags the browser variable name %s", (name) => {
    expect(BROWSER_SECRET_NAME.test(name)).toBe(true);
  });

  it.each(["NEXT_PUBLIC_SITE_NAME", "NEXT_PUBLIC_ANALYTICS_ID", "SUPABASE_SERVICE_ROLE_KEY"])(
    "allows the name %s",
    (name) => {
      expect(BROWSER_SECRET_NAME.test(name)).toBe(false);
    },
  );
});

describe("the browser holds no database key", () => {
  it("serves a home page that contains no key or database address", async () => {
    const { sites, secrets } = testEnv();
    const res = await fetch(sites.healthy);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(secretsFoundIn(html, secrets)).toEqual([]);
  });

  it("ships built browser files that contain no key or database address", () => {
    const { secrets } = testEnv();
    const staticDir = join(root, ".next", "static");
    const clientFiles = filesUnder(staticDir);
    const prerendered = filesUnder(join(root, ".next", "server", "app")).filter((f) =>
      f.endsWith(".html"),
    );

    // An empty scan would pass for the wrong reason.
    expect(clientFiles.some((f) => f.endsWith(".js"))).toBe(true);
    expect(prerendered.length).toBeGreaterThan(0);
    expect(scanFiles(root, [...clientFiles, ...prerendered], secrets)).toEqual([]);
  });

  it("never names a secret as a browser variable in source, config or workflows", () => {
    const files = [
      ...filesUnder(join(root, "src")),
      ...filesUnder(join(root, ".github")),
      join(root, "next.config.ts"),
      join(root, ".env.example"),
      join(root, "package.json"),
    ];
    expect(files.length).toBeGreaterThan(4);
    const offenders = files.filter((file) => BROWSER_SECRET_NAME.test(readFileSync(file, "utf8")));
    expect(offenders.map((f) => f.slice(root.length + 1))).toEqual([]);
  });

  it("does not use next.config to pass environment to the browser", () => {
    const config = nextConfig as Record<string, unknown>;
    expect(config.env).toBeUndefined();
    expect(config.publicRuntimeConfig).toBeUndefined();
    expect(config.serverRuntimeConfig).toBeUndefined();
  });

  it("imports `server-only` in the database client", () => {
    const { specifiers } = imports(join(root, "src/lib/supabase/server.ts"));
    expect(specifiers).toContain("server-only");
  });

  it("lets no client component import the database client", () => {
    const files = filesUnder(join(root, "src")).filter((f) => /\.(ts|tsx)$/.test(f));
    const offenders = files
      .filter((file) => {
        const { specifiers, isClient } = imports(file);
        return isClient && specifiers.some((s) => /supabase/.test(s));
      })
      .map((f) => f.slice(root.length + 1));
    expect(offenders).toEqual([]);
  });
});
