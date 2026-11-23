import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The site's motion rules, checked in the stylesheets themselves.
 *  - Anything that moves or fades must sit inside `@media (prefers-reduced-motion: no-preference)`, so a person who asks
 *    for less motion gets none. The media query must be that and nothing looser: no `not (...)`, no list that holds `reduce`.
 *  - A transition changes only transform, opacity, color, background-color or border-color. Nothing that moves the layout,
 *    and not `all`.
 *  - A rule for keyboard focus has no transition: a ring that fades in would arrive late.
 * The reader below is small and written for this site's plain CSS. It is a guard, not a full CSS parser.
 */

type Declaration = {
  property: string;
  value: string;
  /** The selector of the rule that holds the declaration, such as `.tab:hover`, or a keyframe step such as `60%`. */
  selector: string;
  /** The at-rule headers around it, outermost first, such as `@media (hover: hover)` or `@keyframes warm-up`. */
  context: string[];
};

/** Every declaration in a stylesheet. Comments are dropped first. */
function declarationsOf(css: string): Declaration[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: Declaration[] = [];
  const stack: string[] = [];
  let buffer = "";
  const take = () => {
    const colon = buffer.indexOf(":");
    const property = colon === -1 ? "" : buffer.slice(0, colon).trim();
    if (/^-{0,2}[a-z][a-z-]*$/.test(property) && stack.length > 0) {
      const selector = stack[stack.length - 1] ?? "";
      if (!selector.startsWith("@")) {
        found.push({ property, value: buffer.slice(colon + 1).trim(), selector, context: stack.filter((h) => h.startsWith("@")) });
      }
    }
    buffer = "";
  };
  for (const char of text) {
    if (char === "{") {
      stack.push(buffer.trim().replace(/\s+/g, " "));
      buffer = "";
    } else if (char === "}") {
      take();
      stack.pop();
    } else if (char === ";") {
      take();
    } else {
      buffer += char;
    }
  }
  return found;
}

/** Splits at the top level only, so the commas inside `cubic-bezier(...)` and `var(...)` stay where they are. */
function splitTop(text: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text.trim()) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0 && separator.test(char)) {
      if (current) parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts;
}

const ALLOWED = new Set(["transform", "opacity", "color", "background-color", "border-color"]);
const TIME = /^-?[\d.]+m?s$/;
const TIMING = /^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|(cubic-bezier|steps|linear)\(.*\))$/;
const BEHAVIOUR = new Set(["normal", "allow-discrete"]);

/** The property a `transition` shorthand part animates: the one word that is not a time, a curve, a keyword or a `var()`. */
function transitionTarget(part: string): string | null {
  const words = splitTop(part, /\s/).filter((word) => !TIME.test(word) && !TIMING.test(word) && !BEHAVIOUR.has(word) && !word.startsWith("var("));
  return words[0] ?? null;
}

/** A media query that is `(prefers-reduced-motion: no-preference)`, alone or joined to other terms by `and`, and nothing looser. */
function isNoPreferenceGuard(header: string): boolean {
  if (!header.startsWith("@media")) return false;
  const query = header.slice("@media".length).trim();
  if (/\b(not|reduce)\b|,/.test(query)) return false;
  return query.split(/\s+and\s+/).includes("(prefers-reduced-motion: no-preference)");
}

const isNone = (value: string) => /^(none|0s|0ms|0|auto|initial|unset)$/.test(value.trim());

/** True when the declaration starts motion: a transition, an animation, or smooth scrolling. A reset to none is not motion. */
function startsMotion({ property, value }: Declaration): boolean {
  switch (property) {
    case "transition":
    case "transition-property":
    case "animation":
    case "animation-name":
      return !isNone(value);
    case "transition-duration":
    case "animation-duration":
      return !splitTop(value, /,/).every((part) => isNone(part));
    case "scroll-behavior":
      return value.trim() === "smooth";
    default:
      return false;
  }
}

/** The problems in one stylesheet, as plain sentences. */
function motionProblems(css: string): string[] {
  const problems: string[] = [];
  for (const declaration of declarationsOf(css)) {
    const { property, value, selector, context } = declaration;
    const inKeyframes = context.some((header) => header.startsWith("@keyframes"));
    const where = `${selector} { ${property}: ${value} }`;

    if (inKeyframes && !property.startsWith("--") && !ALLOWED.has(property)) {
      problems.push(`a keyframe changes ${property}, which is not on the allowed list: ${where}`);
    }
    if (!startsMotion(declaration)) continue;

    if (!context.some(isNoPreferenceGuard)) problems.push(`not inside a plain prefers-reduced-motion: no-preference query: ${where}`);
    if (/:focus/.test(selector)) problems.push(`a focus rule starts motion: ${where}`);

    if (property === "transition") {
      for (const part of splitTop(value, /,/)) {
        const target = transitionTarget(part);
        if (target === null || !ALLOWED.has(target)) problems.push(`a transition changes ${target ?? "(nothing named)"}, which is not on the allowed list: ${where}`);
      }
    }
    if (property === "transition-property") {
      for (const name of splitTop(value, /,/)) if (!ALLOWED.has(name.trim())) problems.push(`a transition changes ${name.trim()}, which is not on the allowed list: ${where}`);
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

const GUARD = "@media (prefers-reduced-motion: no-preference)";

describe("the motion check itself", () => {
  it("passes plain good motion, in any order of words", () => {
    expect(motionProblems(`${GUARD} { .a { transition: color 120ms ease-out; } }`)).toEqual([]);
    expect(motionProblems(`${GUARD} { .a { transition: 120ms color; } }`)).toEqual([]);
    expect(motionProblems(`${GUARD} { .a { transition: transform var(--t) var(--ease-out), opacity 90ms cubic-bezier(0.2, 0, 0, 1); } }`)).toEqual([]);
  });

  it("allows a reset to none anywhere, and in a reduce block", () => {
    expect(motionProblems(".a { transition: none; }")).toEqual([]);
    expect(motionProblems("@media (prefers-reduced-motion: reduce) { .a { transition: none; animation: none; transition-duration: 0s; } }")).toEqual([]);
  });

  it("accepts a nested (hover: hover) and no-preference query", () => {
    expect(motionProblems("@media (hover: hover) and (prefers-reduced-motion: no-preference) { .a:hover { transition: background-color 120ms ease-out; } }")).toEqual([]);
    expect(motionProblems("@media (hover: hover) { @media (prefers-reduced-motion: no-preference) { .a:hover { transition: color 1s; } } }")).toEqual([]);
  });

  it("flags a transition that is not guarded", () => {
    expect(motionProblems(".a { transition: color 100ms; }")).toHaveLength(1);
    expect(motionProblems("@media (hover: hover) { .a { transition: color 100ms; } }")).toHaveLength(1);
  });

  it("flags a guard that is looser than no-preference", () => {
    expect(motionProblems("@media not (prefers-reduced-motion: reduce) { .a { transition: color 1s; } }")).toHaveLength(1);
    expect(motionProblems("@media (prefers-reduced-motion: no-preference), (prefers-reduced-motion: reduce) { .a { transition: color 1s; } }")).toHaveLength(1);
    expect(motionProblems("@media (prefers-reduced-motion: reduce) { .a { transition: color 1s; } }")).toHaveLength(1);
  });

  it("flags a transition of layout, or of all", () => {
    expect(motionProblems(`${GUARD} { .a { transition: width 100ms; } }`)).toHaveLength(1);
    expect(motionProblems(`${GUARD} { .a { transition: all 100ms; } }`)).toHaveLength(1);
    expect(motionProblems(`${GUARD} { .a { transition: color 100ms, height 100ms; } }`)).toHaveLength(1);
    expect(motionProblems(`${GUARD} { .a { transition-property: margin-left; } }`)).toHaveLength(1);
  });

  it("covers the longhands and smooth scrolling", () => {
    expect(motionProblems(".a { transition-property: color; }")).toHaveLength(1);
    expect(motionProblems(".a { transition-duration: 200ms; }")).toHaveLength(1);
    expect(motionProblems(".a { animation-name: spin; }")).toHaveLength(1);
    expect(motionProblems(".a { animation-duration: 1s; }")).toHaveLength(1);
    expect(motionProblems("html { scroll-behavior: smooth; }")).toHaveLength(1);
    expect(motionProblems("html { scroll-behavior: auto; }")).toEqual([]);
    expect(motionProblems(`${GUARD} { html { scroll-behavior: smooth; } }`)).toEqual([]);
  });

  it("flags a keyframe that moves layout", () => {
    expect(motionProblems(`${GUARD} { @keyframes grow { from { width: 0; } to { width: 100%; } } .a { animation: grow 1s; } }`)).toHaveLength(2);
    expect(motionProblems(`${GUARD} { @keyframes fade { from { opacity: 0; transform: translateY(2px); } } .a { animation: fade 1s; } }`)).toEqual([]);
  });

  it("flags a transition on a focus rule, even a guarded one", () => {
    expect(motionProblems(`${GUARD} { .a:focus-visible { transition: color 100ms; } }`)).toHaveLength(1);
    expect(motionProblems(`${GUARD} { .a:focus { transition: color 100ms; } }`)).toHaveLength(1);
    expect(motionProblems(`${GUARD} { .a:hover { transition: color 100ms; } }`)).toEqual([]);
  });
});

describe("motion in the stylesheets", () => {
  const files = stylesheets(join(process.cwd(), "src"));

  it("finds the stylesheets", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)("moves nothing unless motion is allowed, never moves layout, and never moves on focus (%s)", (file) => {
    expect(motionProblems(readFileSync(file, "utf8"))).toEqual([]);
  });

  it("fades the hover wash in over --t-hover on the hovered state of a link or button, for a fine pointer, and nowhere else", () => {
    const shared = declarationsOf(readFileSync(join(process.cwd(), "src/components/shared.module.css"), "utf8"));
    const fades = shared.filter((d) => d.property === "transition");
    expect(fades).toHaveLength(1);
    const [fade] = fades;
    expect(fade!.selector).toBe('.hover:not([aria-current="page"]):hover');
    expect(fade!.context.some((header) => isNoPreferenceGuard(header) && header.includes("(hover: hover)"))).toBe(true);
    expect(transitionTarget(fade!.value)).toBe("background-color");
    expect(fade!.value).toContain("var(--t-hover)");
    expect(fade!.value).toContain("var(--ease-out)");

    const wash = shared.filter((d) => d.property === "background-color" && d.selector === fade!.selector);
    expect(wash).toHaveLength(1);
    expect(wash[0]!.context.some((header) => header.includes("(hover: hover)"))).toBe(true);
  });

  it("defines the shared motion tokens once, in the page stylesheet", () => {
    const globals = declarationsOf(readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8"));
    const value = (name: string) => globals.filter((d) => d.property === name).map((d) => d.value);
    expect(value("--t-hover")).toEqual(["120ms"]);
    expect(value("--ease-out")).toEqual(["cubic-bezier(0.16, 1, 0.3, 1)"]);
  });

  it("draws the nav bar on hover only for a pointer that hovers", () => {
    const nav = declarationsOf(readFileSync(join(process.cwd(), "src/components/site-nav.module.css"), "utf8"));
    const hover = nav.filter((d) => d.selector.includes(":hover") && d.property === "transform");
    expect(hover).toHaveLength(1);
    expect(hover[0]!.context.some((header) => header.includes("(hover: hover)"))).toBe(true);
  });
});
