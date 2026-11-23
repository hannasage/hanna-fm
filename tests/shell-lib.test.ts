import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "../src/lib/nav";
import { WORDMARK_HEIGHT, WORDMARK_NAME, WORDMARK_SUFFIX } from "../src/lib/wordmark";

describe("the nav list", () => {
  it("names the five sections in order", () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual(["Map", "Charts", "Shelf", "Match", "Listen"]);
  });

  it("links only Charts, and only to /charts", () => {
    const linked = NAV_ITEMS.filter((item) => item.href !== null);
    expect(linked).toEqual([{ label: "Charts", href: "/charts" }]);
  });
});

describe("the wordmark art", () => {
  const parts = [WORDMARK_NAME, WORDMARK_SUFFIX];

  it("is three rows tall", () => {
    expect(WORDMARK_HEIGHT).toBe(3);
  });

  it("joins into the supplied art, row by row", () => {
    const joined = WORDMARK_NAME.map((row, index) => row + WORDMARK_SUFFIX[index]);
    expect(joined).toEqual([
      "█▄▄   ▄▄▄  ▄▄▄  ▄▄▄   ▄▄▄     ▄▀▀ ▄▄▄▄  ",
      "█  █ █  █  █  █ █  █ █  █    ▀█▀  █ █ █ ",
      "▀  ▀  ▀▀▀▀ ▀  ▀ ▀  ▀  ▀▀▀▀ ▀  ▀   ▀ ▀ ▀ ",
    ]);
  });

  it("starts the accent suffix at the dot", () => {
    expect(WORDMARK_SUFFIX.map((row) => row[0])).toEqual([" ", " ", "▀"]);
  });

  it("draws every part in the same number of rows, each row the same width", () => {
    for (const part of parts) {
      expect(part).toHaveLength(WORDMARK_HEIGHT);
      expect(new Set(part.map((row) => row.length)).size).toBe(1);
    }
  });

  it("uses half-block characters and spaces only, with no tabs", () => {
    for (const row of [...WORDMARK_NAME, ...WORDMARK_SUFFIX]) expect(row).toMatch(/^[▀▄█ ]+$/);
  });

  it("is narrow enough for a 375 px phone at a readable size", () => {
    // At 0.62 em per column, 40 columns at 13 px are about 322 px wide.
    const columns = WORDMARK_NAME[0]!.length + WORDMARK_SUFFIX[0]!.length;
    expect(columns).toBeLessThanOrEqual(40);
  });
});
