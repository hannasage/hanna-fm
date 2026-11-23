import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FAKE_SEED,
  SeedRefusedError,
  assertLocalUrl,
  easternDate,
  generateFakePlays,
} from "../scripts/fake-plays";
import { filesUnder } from "./support/leaks";

/**
 * The fake play generator, with no database. Every date is written out by hand.
 * The generator takes "today" as an Eastern date, so no test reads the clock.
 */

const MONDAY = "2026-03-02";
const WEDNESDAY = "2026-03-04";

function easternDay(iso: string): string {
  // Every fake play lands between 13:00 and 23:00 UTC, so its UTC date is also its Eastern date.
  return iso.slice(0, 10);
}

describe("generateFakePlays", () => {
  const plays = generateFakePlays({ today: WEDNESDAY });

  it("gives the same plays every time for the same day", () => {
    expect(generateFakePlays({ today: WEDNESDAY })).toEqual(plays);
  });

  it("gives different plays for a different seed", () => {
    expect(generateFakePlays({ today: WEDNESDAY, seed: FAKE_SEED + 1 })).not.toEqual(plays);
  });

  it("keeps the same shape when the run day moves, so the chart cases do not depend on the date", () => {
    const other = generateFakePlays({ today: MONDAY });
    // Same week, same Monday: everything on or before the Sunday gap is identical.
    const early = (list: typeof plays) => list.filter((p) => easternDay(p.ended_at) < MONDAY);
    expect(early(other)).toEqual(early(plays));
  });

  it("ends on the day before the run day", () => {
    const last = plays.map((p) => p.ended_at).sort().at(-1)!;
    expect(easternDay(last)).toBe("2026-03-03");
    const onMonday = generateFakePlays({ today: MONDAY }).map((p) => p.ended_at).sort().at(-1)!;
    expect(easternDay(onMonday)).toBe("2026-03-01");
  });

  it("covers about two years", () => {
    const first = plays.map((p) => p.ended_at).sort()[0]!;
    const days = (Date.parse(`${WEDNESDAY}T00:00:00Z`) - Date.parse(`${easternDay(first)}T00:00:00Z`)) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(700);
    expect(days).toBeLessThanOrEqual(740);
  });

  it("never repeats a track and time, which is the plays unique key", () => {
    const keys = new Set(plays.map((p) => `${p.track_uri}|${p.ended_at}`));
    expect(keys.size).toBe(plays.length);
  });

  it("uses only sources the table allows, and gives export rows a length", () => {
    const sources = new Set(plays.map((p) => p.source));
    expect([...sources].sort()).toEqual(["export", "poll"]);
    for (const p of plays) {
      if (p.source === "export") expect(Number.isInteger(p.ms_played) && p.ms_played! >= 0).toBe(true);
      else expect(p.ms_played).toBeNull();
    }
  });

  it("uses names that are obviously fake", () => {
    for (const p of plays) {
      expect(p.track_name).toMatch(/^Fake Track \d+$/);
      expect(p.artist_name).toMatch(/^Fake Artist \d+$/);
      if (p.album_name !== null) expect(p.album_name).toMatch(/^Fake Album \d+$/);
      expect(p.track_uri).toMatch(/^spotify:track:fake\d+$/);
    }
  });

  it("holds plays with no album, and short plays that a chart must not count", () => {
    expect(plays.some((p) => p.album_name === null)).toBe(true);
    expect(plays.some((p) => p.ms_played !== null && p.ms_played < 30_000)).toBe(true);
    expect(plays.some((p) => p.ms_played !== null && p.ms_played >= 30_000)).toBe(true);
  });

  it("is large enough to fill a chart and small enough to seed quickly", () => {
    expect(plays.length).toBeGreaterThan(8_000);
    expect(plays.length).toBeLessThan(40_000);
  });

  it("writes every time as an ISO instant ending in Z", () => {
    for (const p of plays) expect(p.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("easternDate", () => {
  it.each([
    ["2026-03-04T15:00:00Z", "2026-03-04"],
    ["2026-03-05T04:59:59Z", "2026-03-04"],
    ["2026-03-05T05:00:00Z", "2026-03-05"],
    ["2026-07-05T03:59:59Z", "2026-07-04"],
    ["2026-07-05T04:00:00Z", "2026-07-05"],
  ])("reads %s as the Eastern day %s", (instant, day) => {
    expect(easternDate(new Date(instant))).toBe(day);
  });
});

describe("assertLocalUrl", () => {
  it.each([
    "http://127.0.0.1:54321",
    "http://localhost:54321",
    "http://LOCALHOST:54321/",
    "https://127.0.0.1",
  ])("accepts %s", (url) => {
    expect(assertLocalUrl(url).hostname).toMatch(/^(127\.0\.0\.1|localhost)$/);
  });

  it.each([
    "https://abcdefgh.supabase.co",
    "http://127.0.0.1.example.com:54321",
    "http://localhost.example.com",
    "http://localhost@example.com",
    "http://user:pass@127.0.0.1:54321",
    "http://10.0.0.5:54321",
    "http://0.0.0.0:54321",
    "ftp://127.0.0.1",
    "not a url",
    "",
  ])("refuses %s", (url) => {
    expect(() => assertLocalUrl(url)).toThrow(SeedRefusedError);
  });

  it("does not put the refused address in the message", () => {
    try {
      assertLocalUrl("https://secret-project-ref.supabase.co");
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-project-ref");
      return;
    }
    throw new Error("expected a refusal");
  });
});

describe("keeping fake data out of the site", () => {
  it("is imported by nothing under src, so no build can carry it", () => {
    for (const file of filesUnder(join(process.cwd(), "src"))) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/fake-plays|seed-fake-plays|fixtures\//);
    }
  });

  it("is not a script any other npm command runs", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["db:seed-fake"]).toBe("node scripts/seed-fake-plays.ts");
    for (const [name, command] of Object.entries(pkg.scripts)) {
      if (name !== "db:seed-fake") expect(command, name).not.toContain("seed-fake");
    }
    expect(readdirSync(join(process.cwd(), "scripts")).sort()).toEqual(["fake-plays.ts", "seed-fake-plays.ts"]);
  });
});
