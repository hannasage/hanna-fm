import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The site's motion rules, checked in the stylesheets themselves. A rule that moves or fades anything must sit inside
 * `@media (prefers-reduced-motion: no-preference)`, so a person who asks for less motion gets none. A transition may
 * change only transform, opacity, color, background-color or border-color: nothing that moves the layout.
 */

type Declaration = { property: string; value: string; context: string[] };

/** Every declaration in a stylesheet, with the at-rule headers it sits inside. Comments are dropped first. */
function declarationsOf(css: string): Declaration[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: Declaration[] = [];
  const stack: string[] = [];
  let buffer = "";
  for (const char of text) {
    if (char === "{") {
      stack.push(buffer.trim());
      buffer = "";
    } else if (char === "}") {
      pushDeclaration(buffer, stack, found);
      stack.pop();
      buffer = "";
    } else if (char === ";") {
      pushDeclaration(buffer, stack, found);
      buffer = "";
    } else {
      buffer += char;
    }
  }
  return found;
}

function pushDeclaration(buffer: string, stack: string[], found: Declaration[]): void {
  const colon = buffer.indexOf(":");
  if (colon === -1) return;
  const property = buffer.slice(0, colon).trim();
  if (!/^[a-z-]+$/.test(property)) return;
  found.push({ property, value: buffer.slice(colon + 1).trim(), context: stack.filter((header) => header.startsWith("@")) });
}

const ALLOWED = new Set(["transform", "opacity", "color", "background-color", "border-color"]);

/** The problems in one stylesheet, as plain sentences. */
function motionProblems(css: string): string[] {
  const problems: string[] = [];
  for (const { property, value, context } of declarationsOf(css)) {
    const isMotion = property === "transition" || property === "animation" || property === "transition-property";
    if (!isMotion) continue;
    // Keyframe blocks are reached only through an `animation`, so the animation's own guard is the one that counts.
    if (!context.some((header) => /prefers-reduced-motion:\s*no-preference/.test(header))) {
      problems.push(`${property}: ${value} is not inside prefers-reduced-motion: no-preference`);
    }
    if (property !== "animation") {
      const named = value.split(/,(?![^(]*\))/).map((part) => part.trim().split(/\s+/)[0] ?? "");
      for (const name of named) if (!ALLOWED.has(name)) problems.push(`${property} changes ${name}, which is not on the allowed list`);
    }
  }
  for (const { property, context } of declarationsOf(css)) {
    if (property === "animation" || property === "transition") continue;
    if (context.some((header) => header.startsWith("@keyframes")) && !ALLOWED.has(property) && property !== "filter") {
      problems.push(`a keyframe moves ${property}`);
    }
  }
  return problems;
}

function stylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return stylesheets(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

describe("motion in the stylesheets", () => {
  it("catches an unguarded transition and a layout transition (the check itself works)", () => {
    expect(motionProblems(".a { transition: width 100ms; }")).toHaveLength(2);
    expect(motionProblems("@media (prefers-reduced-motion: no-preference) { .a { transition: width 100ms; } }")).toHaveLength(1);
    expect(motionProblems("@media (prefers-reduced-motion: no-preference) { .a { transition: color 100ms; } }")).toEqual([]);
  });

  it.each(stylesheets(join(process.cwd(), "src")))("moves nothing unless motion is allowed, and never moves layout (%s)", (file) => {
    expect(motionProblems(readFileSync(file, "utf8"))).toEqual([]);
  });

  it("fades the hover wash in 120 ms on a pointer that hovers, and never on focus", () => {
    const css = readFileSync(join(process.cwd(), "src/components/shared.module.css"), "utf8");
    expect(css).toMatch(/@media \(hover: hover\) and \(prefers-reduced-motion: no-preference\)\s*\{[^}]*\.hover:not\(\[aria-current="page"\]\):hover\s*\{[^}]*transition:\s*background-color 120ms/);
    expect(css).not.toMatch(/:focus[^{]*\{[^}]*transition/);
  });
});
