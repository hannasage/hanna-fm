import { describe, expect, it } from "vitest";
import { testEnv } from "./support/env";

describe("the shell over HTTP", () => {
  const base = () => testEnv().sites.healthy;

  it("gives the wordmark a text name and hides the art from screen readers", async () => {
    const html = await (await fetch(`${base()}/`)).text();
    const link = /<a[^>]*aria-label="hanna\.fm"[^>]*>/.exec(html)?.[0] ?? "";
    expect(link).toContain('href="/"');
    const art = /<pre[^>]*>/.exec(html)?.[0] ?? "";
    expect(art).toContain('aria-hidden="true"');
  });

  it("lists the five sections, with a link on Charts only", async () => {
    const html = await (await fetch(`${base()}/`)).text();
    const nav = /<nav[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
    for (const label of ["Map", "Charts", "Shelf", "Match", "Listen"]) expect(nav).toContain(label);
    const hrefs = [...nav.matchAll(/<a[^>]*href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["/charts"]);
    expect(nav.match(/coming soon/gi)?.length).toBe(4);
  });

  it("renders the Now playing slot empty", async () => {
    const html = await (await fetch(`${base()}/`)).text();
    expect(html).toMatch(/<div[^>]*id="now-playing"[^>]*><\/div>/);
  });

  it("serves the Charts placeholder", async () => {
    const res = await fetch(`${base()}/charts`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Charts coming next");
  });

  it("keeps the home page", async () => {
    const res = await fetch(`${base()}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("In development");
  });
});
