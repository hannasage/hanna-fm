/**
 * Small readers for the HTML the site sends. The markup comes from React's server renderer, which writes
 * plain, regular tags, so a few patterns are enough. Nothing here runs a page or a script.
 */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Turns the entities React writes back into characters. Anything else is left as it is. */
export function decode(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/g, (whole, name: string) => ENTITIES[name] ?? whole);
}

/** The words a person sees in a piece of markup: tags removed, entities decoded, space collapsed. */
export function textOf(html: string): string {
  return decode(html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export type Cell = { tag: "th" | "td"; attrs: string; html: string; text: string };

/** The one table of a page, or null when there is none. */
export function tableOf(html: string): string | null {
  return /<table[\s\S]*?<\/table>/.exec(html)?.[0] ?? null;
}

/** The rows of the table body, each as markup. */
export function bodyRows(table: string): string[] {
  const body = /<tbody[^>]*>([\s\S]*?)<\/tbody>/.exec(table)?.[1] ?? "";
  return [...body.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)].map((m) => m[0]);
}

export function cellsOf(row: string): Cell[] {
  return [...row.matchAll(/<(th|td)([^>]*)>([\s\S]*?)<\/\1>/g)].map((m) => ({
    tag: m[1] as "th" | "td",
    attrs: m[2] ?? "",
    html: m[3] ?? "",
    text: textOf(m[3] ?? ""),
  }));
}

/** Every href in a piece of markup, decoded. */
export function hrefsOf(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\shref="([^"]*)"/g)].map((m) => decode(m[1] ?? ""));
}

/** The markup of the first element with the given tag whose opening tag matches the pattern. */
export function elementOf(html: string, tag: string, opening: RegExp): string | null {
  for (const match of html.matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "g"))) {
    const open = /^<[^>]*>/.exec(match[0])?.[0] ?? "";
    if (opening.test(open)) return match[0];
  }
  return null;
}
