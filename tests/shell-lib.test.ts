import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORDMARK_HEIGHT, WORDMARK_NAME, WORDMARK_SUFFIX } from "../src/lib/wordmark";

describe("the wordmark art", () => {
  const parts = [WORDMARK_NAME, WORDMARK_SUFFIX];

  it("draws both parts in the same number of rows, each row the same width", () => {
    for (const part of parts) {
      expect(part).toHaveLength(WORDMARK_HEIGHT);
      expect(new Set(part.map((row) => row.length)).size).toBe(1);
    }
  });

  it("uses half-block characters and spaces only, with no tabs", () => {
    for (const row of [...WORDMARK_NAME, ...WORDMARK_SUFFIX]) expect(row).toMatch(/^[▀▄█ ]+$/);
  });

  it("is sized by a divisor in the CSS that fits every column of the art", () => {
    const css = readFileSync(join(process.cwd(), "src/components/wordmark.module.css"), "utf8");
    const divisor = Number(/font-size:\s*calc\(100cqw \/ ([\d.]+)\)/.exec(css)?.[1]);
    const columns = WORDMARK_NAME[0]!.length + WORDMARK_SUFFIX[0]!.length;
    // One column is at most 0.62 em wide, so the art is columns x 0.62 em across.
    // The font size is the box width divided by the divisor, so the divisor must reach that many em.
    expect(Number.isFinite(divisor)).toBe(true);
    expect(divisor).toBeGreaterThanOrEqual(columns * 0.62);
  });
});
