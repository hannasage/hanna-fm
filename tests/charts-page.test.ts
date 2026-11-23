import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearPlays, insertPlays, plays, withDb, type Chart, type ChartRow, type Play } from "./support/chart-data";
import { testEnv, type SiteName } from "./support/env";
import { bodyRows, cellsOf, decode, elementOf, hrefsOf, tableOf, textOf } from "./support/html";

/**
 * The Charts page over HTTP, against the local database and the built site.
 * Every play is synthetic and dated in 2026-02, long before any day these tests run, so the three
 * weeks below are finished weeks whatever the date. Weeks start on a Monday:
 *   W1 2026-02-02   W2 2026-02-09   W3 2026-02-16
 *
 *   week  track A  track B  track C  track D  track E  track F
 *   W1    5 (1st)  2 (4th)  4 (2nd)  3 (3rd)  -        -
 *   W2    5 (1st)  3 (2nd)  2 (3rd)  -        1 (4th)  -
 *   W3    4 (2nd)  6 (1st)  -        2 (3rd)  1 (5th)  1 (4th, longer plays win the tie)
 *
 * One more play, of track G in the week of 2026-01-12, makes that the first week. The weeks 2026-01-19 and
 * 2026-01-26 are inside the range and hold no counted play, so they are empty weeks.
 *
 * So in W2: A holds, B climbs 2, C falls 1, E is NEW. In W3: B climbs 1, A falls 1, D is RE-ENTRY
 * (on the chart in W1, off in W2), F is NEW, E falls 1.
 */
const env = testEnv();
const FIRST = "2026-01-12";
const GAP_A = "2026-01-19";
const GAP_B = "2026-01-26";
const BEFORE_FIRST = "2026-01-05";
const AFTER_LATEST = "2026-02-23";
const W1 = "2026-02-02";
const W2 = "2026-02-09";
const W3 = "2026-02-16";

const XSS_TRACK = "<img src=x onerror=alert(1)>";
const XSS_ARTIST = '<script>alert("a&b")</script>';
const XSS_ALBUM = 'Album <b>bold</b> & "quotes"';

function named(track: string, count: number, startIso: string, overrides: Partial<Play> = {}): Play[] {
  return plays(track, count, startIso, { track_name: `Track ${track}`, artist_name: `Band ${track}`, album_name: `Album ${track}`, ...overrides });
}

function dataset(): Play[] {
  const f = { track_name: XSS_TRACK, artist_name: XSS_ARTIST, album_name: XSS_ALBUM, ms_played: 250_000 };
  return [
    ...named("G", 1, "2026-01-13T15:00:00Z"),
    ...named("A", 5, "2026-02-03T15:00:00Z"),
    ...named("B", 2, "2026-02-03T16:00:00Z"),
    ...named("C", 4, "2026-02-03T17:00:00Z"),
    ...named("D", 3, "2026-02-03T18:00:00Z"),
    ...named("A", 5, "2026-02-10T15:00:00Z"),
    ...named("B", 3, "2026-02-10T16:00:00Z"),
    ...named("C", 2, "2026-02-10T17:00:00Z"),
    ...named("E", 1, "2026-02-10T18:00:00Z"),
    ...named("A", 4, "2026-02-17T15:00:00Z"),
    ...named("B", 6, "2026-02-17T16:00:00Z"),
    ...named("D", 2, "2026-02-17T17:00:00Z"),
    ...named("E", 1, "2026-02-17T18:00:00Z"),
    ...named("F", 1, "2026-02-17T19:00:00Z", f),
  ];
}

async function page(query = "", site: SiteName = "healthy") {
  const res = await fetch(`${env.sites[site]}/charts${query ? `?${query}` : ""}`);
  return { res, html: await res.text() };
}

async function api(query: string): Promise<Chart> {
  const res = await fetch(`${env.sites.healthy}/api/charts/weekly?${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Chart;
}

/** What the Move cell must say for an API row, worked out here from the API numbers alone. */
function expectedMove(row: ChartRow): string {
  if (row.weeks_on_chart === 1) return "NEW";
  if (row.last_week_rank === null) return "RE-ENTRY";
  const steps = row.last_week_rank - row.rank;
  if (steps === 0) return "= No change";
  const places = `${Math.abs(steps)} ${Math.abs(steps) === 1 ? "place" : "places"}`;
  return steps > 0 ? `\u25B2 ${Math.abs(steps)} Up ${places}` : `\u25BC ${Math.abs(steps)} Down ${places}`;
}

/** The text of the span marked data-part in a piece of markup, or null. */
function partText(html: string, part: string): string | null {
  const found = new RegExp(`<span[^>]*data-part="${part}"[^>]*>([\\s\\S]*?)</span>`).exec(html)?.[1];
  return found === undefined ? null : textOf(found);
}

/** The table body as rows of cell text, with the markup beside it. */
function rowsOf(html: string) {
  const table = tableOf(html);
  expect(table, "the page has a table").not.toBeNull();
  return bodyRows(table!).map((row) => ({ html: row, cells: cellsOf(row) }));
}

function rowNamed(html: string, name: string) {
  const row = rowsOf(html).find((r) => r.cells.find((c) => c.tag === "th")?.text.startsWith(name));
  expect(row, `a row for ${name}`).toBeDefined();
  return row!;
}

describe("the Charts page with data", () => {
  beforeAll(async () => {
    await clearPlays();
    await insertPlays(dataset());
  }, 60_000);
  afterAll(clearPlays);

  describe("the default view", () => {
    it("shows the track chart of the latest finished week, ranked", async () => {
      const { res, html } = await page();
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const titles = rowsOf(html).map((r) => r.cells[2]!.text);
      ["Track B", "Track A", "Track D", XSS_TRACK, "Track E"].forEach((name, i) => expect(titles[i]!.startsWith(name), name).toBe(true));
      expect(rowsOf(html).map((r) => r.cells[0]!.text)).toEqual(["1", "2", "3", "4", "5"]);
    });

    it("names the week in the table caption, with its Monday to Sunday span", async () => {
      const { html } = await page();
      const caption = /<caption[^>]*>([\s\S]*?)<\/caption>/.exec(tableOf(html)!)?.[1] ?? "";
      expect(textOf(caption)).toContain("Feb 16 – Feb 22, 2026");
      expect(textOf(caption)).toContain("tracks");
    });

    it("has one h1, the main landmark and the skip target the shell gave it", async () => {
      const { html } = await page();
      expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
      expect(html).toMatch(/<main[^>]*id="content"[^>]*>/);
      expect(html).toMatch(/<a[^>]*href="#content"[^>]*>Skip to content<\/a>/);
    });

    it("keeps aria-current=page on the Charts link of the site nav", async () => {
      const { html } = await page("kind=album");
      const nav = /<nav[^>]*aria-label="Main"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
      expect(nav).toMatch(/<a[^>]*aria-current="page"[^>]*>Charts<\/a>/);
    });
  });

  describe("every chart agrees with the API", () => {
    const kinds = ["track", "artist", "album"] as const;
    for (const kind of kinds) {
      for (const week of [W1, W2, W3]) {
        it(`${kind} ${week}: same ranks, names, artists and numbers as the API`, async () => {
          const chart = await api(`kind=${kind}&week=${week}`);
          const { html } = await page(`kind=${kind}&week=${week}`);
          const rows = rowsOf(html);
          expect(rows).toHaveLength(chart.rows.length);
          chart.rows.forEach((row, i) => {
            const cells = rows[i]!.cells;
            expect(cells).toHaveLength(8);
            const title = cells[2]!;
            expect(title.tag).toBe("th");
            expect(title.attrs).toContain('scope="row"');
            const shownName = partText(title.html, "name");
            if (kind === "artist") {
              expect(shownName).toBe(row.name);
              expect(title.html).not.toContain('data-part="artist"');
            } else {
              expect(partText(title.html, "artist")).toBe(row.artist);
              // The API writes an album as "Album - Artist". The page shows the album on one line and the artist on the next.
              expect(kind === "album" ? `${shownName} - ${row.artist}` : shownName).toBe(row.name);
            }
            expect(cells[1]!.text.replace(/\s+/g, " ")).toBe(expectedMove(row));
            expect(cells[0]!.text).toBe(String(row.rank));
            expect(cells[3]!.text).toBe(row.last_week_rank === null ? "– No rank last week" : String(row.last_week_rank));
            expect(cells[4]!.text).toBe(String(row.peak_rank));
            expect(cells[5]!.text).toBe(String(row.weeks_on_chart));
            expect(cells[6]!.text).toBe(String(row.plays));
            expect(cells[7]!.text).toBe(String(row.minutes));
          });
        });
      }
    }

    it("uses the caption to say which kind of chart it is", async () => {
      for (const [kind, word] of [["artist", "artists"], ["album", "albums"]] as const) {
        const { html } = await page(`kind=${kind}`);
        expect(textOf(/<caption[^>]*>([\s\S]*?)<\/caption>/.exec(html)![1]!)).toContain(word);
      }
    });
  });

  describe("NEW, RE-ENTRY and movement", () => {
    it("shows up, down and no change with a symbol and with words", async () => {
      const { html } = await page(`week=${W2}`);
      const up = rowNamed(html, "Track B").cells[1]!;
      expect(up.text).toContain("▲");
      expect(up.text).toContain("Up 2");
      const down = rowNamed(html, "Track C").cells[1]!;
      expect(down.text).toContain("▼");
      expect(down.text).toContain("Down 1");
      const same = rowNamed(html, "Track A").cells[1]!;
      expect(same.text).toContain("No change");
      expect(same.text).not.toMatch(/[▲▼]/);
    });

    it("hides the dash from screen readers and gives them words instead", async () => {
      const { html } = await page(`week=${W2}`);
      const cell = rowNamed(html, "Track E").cells[3]!;
      expect(cell.html).toMatch(/<span[^>]*aria-hidden="true"[^>]*>\u2013<\/span>/);
      expect(cell.html).toContain("No rank last week");
    });

    it("flags a first week as NEW in text, with no arrow and a dash for last week", async () => {
      const { html } = await page(`week=${W2}`);
      const row = rowNamed(html, "Track E");
      expect(row.cells[1]!.text).toBe("NEW");
      expect(row.cells[1]!.text).not.toMatch(/[▲▼]|Up|Down/);
      expect(row.cells[3]!.text).toBe("– No rank last week");
      expect(row.cells[5]!.text).toBe("1");
    });

    it("flags a return after a gap as RE-ENTRY, with no arrow", async () => {
      const { html } = await page(`week=${W3}`);
      const row = rowNamed(html, "Track D");
      expect(row.cells[1]!.text).toBe("RE-ENTRY");
      expect(row.cells[3]!.text).toBe("– No rank last week");
      expect(Number(row.cells[5]!.text)).toBeGreaterThan(1);
    });

    it("flags every row NEW in the first week it holds", async () => {
      const { html } = await page(`week=${W1}`);
      const moves = rowsOf(html).map((r) => r.cells[1]!.text);
      expect(moves).toEqual(["NEW", "NEW", "NEW", "NEW"]);
    });

    it("gives a flag to no row that was on the chart last week", async () => {
      const { html } = await page(`week=${W3}`);
      for (const name of ["Track A", "Track B"]) {
        expect(rowNamed(html, name).cells[1]!.text).not.toMatch(/NEW|RE-ENTRY/);
      }
    });
  });

  describe("the kind tabs", () => {
    function tabs(html: string) {
      const nav = elementOf(html, "nav", /aria-label="Chart type"/);
      expect(nav, "a nav for the chart types").not.toBeNull();
      return [...nav!.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
        attrs: m[1] ?? "",
        label: textOf(m[2] ?? ""),
        href: decode(/href="([^"]*)"/.exec(m[1] ?? "")?.[1] ?? ""),
      }));
    }

    it("lists Tracks, Artists and Albums as plain links, not buttons or client state", async () => {
      const { html } = await page();
      const found = tabs(html);
      expect(found.map((t) => [t.label, t.href])).toEqual([
        ["Tracks", "/charts"],
        ["Artists", "/charts?kind=artist"],
        ["Albums", "/charts?kind=album"],
      ]);
      expect(elementOf(html, "nav", /aria-label="Chart type"/)).not.toMatch(/<button|role="tab"/);
    });

    it("marks the shown kind with aria-current and no other", async () => {
      for (const [query, label] of [["", "Tracks"], ["kind=track", "Tracks"], ["kind=artist", "Artists"], ["kind=album", "Albums"]] as const) {
        const { html } = await page(query);
        const current = tabs(html).filter((t) => t.attrs.includes('aria-current="page"'));
        expect(current.map((t) => t.label), query).toEqual([label]);
      }
    });

    it("drops the week when the kind changes, because each kind has its own first week", async () => {
      const { html } = await page(`week=${W2}`);
      expect(tabs(html).map((t) => t.href)).toEqual(["/charts", "/charts?kind=artist", "/charts?kind=album"]);
    });

    it("shows the artist chart without an artist line, and the album chart with one", async () => {
      const artist = await page("kind=artist");
      expect(rowsOf(artist.html)[0]!.cells[2]!.text).toBe("Band B");
      const album = await page("kind=album");
      const title = rowsOf(album.html)[0]!.cells[2]!;
      expect(partText(title.html, "name")).toBe("Album B");
      expect(partText(title.html, "artist")).toBe("Band B");
      expect(title.text).not.toContain("Album B - Band B");
      expect(album.html).not.toContain("Album B - Band B");
    });
  });

  describe("the week picker", () => {
    it("links to the previous and the next week, and leaves a link out at each end", async () => {
      const middle = await page(`week=${W2}`);
      expect(hrefsOf(middle.html)).toEqual(expect.arrayContaining([`/charts?week=${W1}`, `/charts?week=${W3}`]));

      const last = await page(`week=${W3}`);
      expect(hrefsOf(last.html)).toContain(`/charts?week=${W2}`);
      expect(hrefsOf(last.html)).not.toContain(`/charts?week=${AFTER_LATEST}`);
      expect(textOf(last.html)).toContain("Next week");

      const first = await page(`week=${FIRST}`);
      expect(hrefsOf(first.html)).toContain(`/charts?week=${GAP_A}`);
      expect(hrefsOf(first.html)).not.toContain(`/charts?week=${BEFORE_FIRST}`);
      expect(textOf(first.html)).toContain("Previous week");
    });

    it("says in words that a missing link is the first or the latest week", async () => {
      const last = await page(`week=${W3}`);
      expect(textOf(last.html)).toContain("Next week (latest week)");
      const first = await page(`week=${FIRST}`);
      expect(textOf(first.html)).toContain("Previous week (first week)");
    });

    it("keeps the kind in the previous and next links", async () => {
      const { html } = await page(`kind=album&week=${W2}`);
      expect(hrefsOf(html)).toEqual(expect.arrayContaining([`/charts?kind=album&week=${W1}`, `/charts?kind=album&week=${W3}`]));
    });

    it("lists every week from the first to the latest in a GET form, so it works with no script", async () => {
      const { html } = await page(`kind=artist&week=${W2}`);
      const form = elementOf(html, "form", /method="get"/i);
      expect(form, "a GET form").not.toBeNull();
      expect(form).toMatch(/action="\/charts"/);
      expect(form).toMatch(/<label[^>]*for="chart-week"/);
      const options = [...form!.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map((m) => ({
        value: /value="([^"]*)"/.exec(m[1] ?? "")?.[1],
        selected: (m[1] ?? "").includes("selected"),
        label: textOf(m[2] ?? ""),
      }));
      expect(options.map((o) => o.value)).toEqual([W3, W2, W1, GAP_B, GAP_A, FIRST]);
      expect(options.filter((o) => o.selected).map((o) => o.value)).toEqual([W2]);
      expect(options[1]!.label).toContain("Feb 9 – Feb 15, 2026");
      expect(form).toMatch(/<select[^>]*name="week"/);
      expect(form).toMatch(/<input[^>]*type="hidden"[^>]*name="kind"[^>]*value="artist"/);
      expect(form).toMatch(/<button[^>]*type="submit"/);
    });

    it("leaves the kind out of the form for the track chart", async () => {
      const { html } = await page();
      expect(elementOf(html, "form", /method="get"/i)).not.toMatch(/name="kind"/);
    });

    it("selects the week shown when none was asked for", async () => {
      const { html } = await page();
      const form = elementOf(html, "form", /method="get"/i)!;
      expect(/<option[^>]*selected[^>]*value="([^"]*)"|<option[^>]*value="([^"]*)"[^>]*selected/.exec(form)?.slice(1).find(Boolean)).toBe(W3);
    });

    it("shows no week-in-progress note for a finished week", async () => {
      const { html } = await page();
      expect(textOf(html).toLowerCase()).not.toContain("week in progress");
    });
  });

  describe("the table", () => {
    it("is a real table with a caption, column headers and a row header on every row", async () => {
      const { html } = await page();
      const table = tableOf(html)!;
      expect(table).toMatch(/<caption/);
      const heads = [...table.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/g)]
        .filter((m) => (m[1] ?? "").includes('scope="col"'))
        .map((m) => textOf(m[2] ?? ""));
      expect(heads).toEqual(["Rank", "Move", "Title", "Last week", "Peak", "Weeks", "Plays", "Minutes"]);
      expect(table).not.toContain("<abbr");
      for (const row of rowsOf(html)) {
        expect(row.cells.filter((c) => c.tag === "th")).toHaveLength(1);
        expect(row.cells[2]!.attrs).toContain('scope="row"');
      }
    });

    it.each([
      ["kind=artist", "Artist"],
      ["kind=album", "Album"],
    ] as const)("names the first column after what the chart ranks (%s)", async (query, head) => {
      const { html } = await page(query);
      const heads = [...tableOf(html)!.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/g)]
        .filter((m) => (m[1] ?? "").includes('scope="col"'))
        .map((m) => textOf(m[2] ?? ""));
      expect(heads[2]).toBe(head);
      expect(heads).toHaveLength(8);
    });

    it("sets numbers in tabular figures", () => {
      const css = readFileSync(join(process.cwd(), "src/components/chart-table.module.css"), "utf8");
      expect(css).toMatch(/font-variant-numeric:\s*tabular-nums/);
    });

    it("needs no script: the table and the week form carry no event handler", async () => {
      const { html } = await page();
      const main = /<main[\s\S]*<\/main>/.exec(html)?.[0] ?? "";
      expect(main).not.toMatch(/<[a-z][^>]*\son[a-z]+=/i);
    });
  });

  describe("names are untrusted text", () => {
    it("shows a name that holds markup as plain text", async () => {
      const { html } = await page(`week=${W3}`);
      expect(html).not.toContain(XSS_TRACK);
      expect(html).not.toContain("<img src=x");
      expect(html).not.toContain("<script>alert");
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
      const row = rowNamed(html, XSS_TRACK);
      expect(row.cells[2]!.text).toContain(XSS_TRACK);
      expect(row.cells[2]!.text).toContain(XSS_ARTIST);
    });

    it("shows an artist and an album with markup as plain text", async () => {
      const artist = await page(`kind=artist&week=${W3}`);
      expect(artist.html).not.toContain("<script>alert");
      expect(rowNamed(artist.html, XSS_ARTIST).cells[2]!.text).toBe(XSS_ARTIST);
      const album = await page(`kind=album&week=${W3}`);
      expect(album.html).not.toContain("<b>bold</b>");
      expect(rowNamed(album.html, XSS_ALBUM).cells[2]!.text).toContain(XSS_ALBUM);
    });

    it("never puts a name in a link", async () => {
      for (const kind of ["track", "artist", "album"]) {
        const { html } = await page(`kind=${kind}&week=${W3}`);
        const table = tableOf(html)!;
        expect(hrefsOf(table)).toEqual([]);
        for (const href of hrefsOf(html)) expect(href).toMatch(/^(\/|#)/);
      }
    });

    it("has no raw-HTML escape hatch anywhere in the source", () => {
      const roots = ["src/app/charts", "src/components", "src/lib"];
      const files = roots.flatMap((dir) => listFiles(join(process.cwd(), dir)));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) expect(readFileSync(file, "utf8"), file).not.toContain("dangerouslySetInnerHTML");
    });
  });

  describe("the note on how the chart counts", () => {
    it("states the counting rule in plain words", async () => {
      const { html } = await page();
      const text = textOf(html);
      expect(text).toContain("A play is a listen of 30 seconds or more.");
      expect(text).toContain("Weeks run Monday to Sunday, Eastern time.");
      expect(text).toContain("Charts trail real time by a day.");
      expect(text).toContain("Ties break by minutes listened.");
    });
  });

  describe("an invalid request is a 400", () => {
    const invalid: [string, string][] = [
      ["a kind that is not a chart", "kind=genre"],
      ["a kind with the wrong case", "kind=Track"],
      ["an empty kind", "kind="],
      ["a kind given twice", "kind=track&kind=album"],
      ["a week that is not a Monday", "week=2026-02-10"],
      ["a week that is not a date", "week=soon"],
      ["a week that does not exist", "week=2026-02-30"],
      ["an empty week", "week="],
      ["a week given twice", `week=${W1}&week=${W2}`],
    ];

    it.each(invalid)("answers %s with 400, a plain message, no table and a way back", async (_label, query) => {
      const { res, html } = await page(query);
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(tableOf(html)).toBeNull();
      expect(html).toMatch(/<h2[^>]*>That chart does not exist<\/h2>/);
      expect(hrefsOf(html)).toContain("/charts");
      expect(html).not.toMatch(/\bat\s+\S+\s+\(|stack|TypeError|Error:/);
    });

    it("keeps the chart tabs on a 400, so a visitor can pick a chart, with none marked current", async () => {
      const { html } = await page("kind=genre");
      const nav = elementOf(html, "nav", /aria-label="Chart type"/);
      expect(nav).not.toBeNull();
      expect(hrefsOf(nav!)).toEqual(["/charts", "/charts?kind=artist", "/charts?kind=album"]);
      expect(nav).not.toContain("aria-current");
    });

    it("does not echo a bad parameter into the page", async () => {
      const { res, html } = await page(`kind=${encodeURIComponent("<script>alert(7)</script>")}`);
      expect(res.status).toBe(400);
      // The framework repeats the address inside its own data script, as encoded text. The page itself must not show it.
      const main = /<main[\s\S]*<\/main>/.exec(html)?.[0] ?? "";
      expect(main).not.toContain("alert(7)");
      expect(html).not.toContain("<script>alert(7)");
    });

    it("ignores a parameter it does not know", async () => {
      const { res, html } = await page(`utm_source=newsletter&kind=artist`);
      expect(res.status).toBe(200);
      expect(tableOf(html)).not.toBeNull();
    });
  });

  describe("a week outside the chart is a 404", () => {
    it.each([
      ["before the first week", BEFORE_FIRST],
      ["after the latest week", AFTER_LATEST],
    ])("answers a week %s with 404, no table and a way back", async (_label, week) => {
      const { res, html } = await page(`week=${week}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(tableOf(html)).toBeNull();
      expect(html).toMatch(/<h2[^>]*>No chart for that week<\/h2>/);
      expect(hrefsOf(html)).toContain("/charts");
    });

    it("keeps the kind in the way back, and keeps the tabs", async () => {
      const { res, html } = await page(`kind=album&week=${BEFORE_FIRST}`);
      expect(res.status).toBe(404);
      expect(hrefsOf(html)).toContain("/charts?kind=album");
      expect(elementOf(html, "nav", /aria-label="Chart type"/)).not.toBeNull();
    });

    it("names the range a week must fall in", async () => {
      const { html } = await page(`week=${BEFORE_FIRST}`);
      const text = textOf(html);
      expect(text).toContain("Jan 12, 2026");
      expect(text).toContain("Feb 16, 2026");
    });

    it("refuses the running week with 404 although the API accepts it, because the page lists only weeks that have a chart", async () => {
      const current = await withDb(async (db) =>
        (await db.query<{ monday: string }>(
          "select to_char(date_trunc('week', now() at time zone 'America/New_York')::date, 'YYYY-MM-DD') as monday",
        )).rows[0]!.monday,
      );
      // The data ends in February, so the current week is later than the latest week of the chart.
      expect(current > W3).toBe(true);
      const api = await fetch(`${env.sites.healthy}/api/charts/weekly?week=${current}`);
      expect(api.status).toBe(200);
      const { res } = await page(`week=${current}`);
      expect(res.status).toBe(404);
    });
  });

  describe("an empty week inside the range", () => {
    it.each([GAP_A, GAP_B])("shows a message in place of the rows for %s, and keeps the week controls", async (week) => {
      const { res, html } = await page(`week=${week}`);
      expect(res.status).toBe(200);
      expect(tableOf(html)).toBeNull();
      const text = textOf(html);
      expect(text).toContain("Top tracks");
      expect(text).toContain("No plays counted this week.");
      expect(hrefsOf(html)).toEqual(expect.arrayContaining(["/charts?week=" + addDay(week, -7), "/charts?week=" + addDay(week, 7)]));
      expect(elementOf(html, "form", /method="get"/i)).not.toBeNull();
      expect(elementOf(html, "nav", /aria-label="Chart type"/)).not.toBeNull();
    });

    it("does not borrow the nearest week that has a chart", async () => {
      const { html } = await page(`week=${GAP_B}`);
      expect(html).not.toContain("Track A");
      expect(html).not.toContain("Track G");
    });

    it("has its own chart on the first week", async () => {
      const { res, html } = await page(`week=${FIRST}`);
      expect(res.status).toBe(200);
      expect(rowsOf(html).map((r) => r.cells[1]!.text)).toEqual(["NEW"]);
    });
  });

  describe("headers and the head", () => {
    it("lets a shared cache keep a chart for five minutes, like the API does", async () => {
      const page200 = await page();
      expect(page200.res.headers.get("cache-control")).toBe("public, s-maxage=300, stale-while-revalidate=600");
      const empty = await page(`week=${GAP_A}`);
      expect(empty.res.headers.get("cache-control")).toBe("public, s-maxage=300, stale-while-revalidate=600");
      const api = await fetch(`${env.sites.healthy}/api/charts/weekly`);
      expect(api.headers.get("cache-control")).toBe(page200.res.headers.get("cache-control"));
    });

    it("puts a canonical link in the head of a chart, with the kind and week the reader asked for and nothing else", async () => {
      const { html } = await page(`utm_source=x&kind=artist&week=${W2}`);
      const head = /<head>[\s\S]*<\/head>/.exec(html)?.[0] ?? "";
      const canonical = /<link[^>]*rel="canonical"[^>]*href="([^"]*)"/.exec(head)?.[1];
      expect(canonical).toBeDefined();
      expect(new URL(decode(canonical!), "http://x").pathname + new URL(decode(canonical!), "http://x").search).toBe(`/charts?kind=artist&week=${W2}`);
      expect(head).not.toMatch(/<meta[^>]*name="robots"/);
    });

    it("keeps a chart without noindex, and a plain address canonical to itself", async () => {
      const { html } = await page();
      const head = /<head>[\s\S]*<\/head>/.exec(html)?.[0] ?? "";
      expect(head).toMatch(/rel="canonical"/);
      expect(html).not.toMatch(/<meta[^>]*name="robots"[^>]*noindex/);
    });

    it.each([
      ["a 400", "kind=genre"],
      ["a 404", `week=${BEFORE_FIRST}`],
      ["an empty week", `week=${GAP_A}`],
    ])("puts noindex in the head, and no canonical, for %s", async (_label, query) => {
      const { html } = await page(query);
      const head = /<head>[\s\S]*<\/head>/.exec(html)?.[0] ?? "";
      expect(head).toMatch(/<meta[^>]*name="robots"[^>]*content="noindex/);
      expect(head).not.toMatch(/rel="canonical"/);
      const main = /<main[\s\S]*<\/main>/.exec(html)?.[0] ?? "";
      expect(main).not.toMatch(/<meta/);
    });
  });
});

describe("the Charts page with no plays", () => {
  beforeAll(clearPlays);

  it.each(["", "kind=artist", "kind=album"])("says there is no chart yet (%s)", async (query) => {
    const { res, html } = await page(query);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(tableOf(html)).toBeNull();
    expect(textOf(html)).toContain("No chart yet");
    const head = /<head>[\s\S]*<\/head>/.exec(html)?.[0] ?? "";
    expect(head).toMatch(/<meta[^>]*name="robots"[^>]*content="noindex/);
  });

  it("answers a week the same way, since no week exists", async () => {
    const { html } = await page(`week=${W2}`);
    expect(tableOf(html)).toBeNull();
    expect(textOf(html)).toContain("No chart yet");
  });
});

describe("the Charts page when the database fails", () => {
  const sites: [SiteName, string][] = [
    ["refused", "nothing listens at the database address"],
    ["hanging", "the database never answers"],
    ["badKey", "the database refuses the key"],
    ["missingEnv", "the database settings are missing"],
    ["malformed", "the database sends a shape the page does not know"],
  ];

  it.each(sites)("%s: shows an outage message with a retry hint and nothing internal", async (site) => {
    const { res, html } = await page("", site);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = textOf(html);
    expect(text).toContain("Charts are unavailable");
    expect(text).toMatch(/try again/i);
    expect(tableOf(html)).toBeNull();
    expect(hrefsOf(html)).toContain("/charts");
    const head = /<head>[\s\S]*<\/head>/.exec(html)?.[0] ?? "";
    expect(head).toMatch(/<meta[^>]*name="robots"[^>]*content="noindex/);
    expect(head).not.toMatch(/rel="canonical"/);
    // No stack, no error name, no address or key of the database.
    expect(html).not.toMatch(/\bat\s+\S+\s+\(|stack|TypeError|ChartShapeError|ECONNREFUSED|fetch failed|PGRST|127\.0\.0\.1/);
    for (const { value } of env.secrets) expect(html.includes(value)).toBe(false);
  });

  it("keeps the site header and the chart tabs of a failed page, with the kind that failed marked current", async () => {
    const { res, html } = await page("kind=artist", "refused");
    expect(res.status).toBe(503);
    expect(html).toMatch(/<main[^>]*id="content"/);
    expect(html).toMatch(/aria-label="Main"/);
    const nav = elementOf(html, "nav", /aria-label="Chart type"/);
    expect(nav, "chart tabs on the outage page").not.toBeNull();
    expect(hrefsOf(nav!)).toEqual(["/charts", "/charts?kind=artist", "/charts?kind=album"]);
    expect(nav).toMatch(/<a[^>]*aria-current="page"[^>]*>Artists<\/a>/);
  });

  it("offers a retry link to the same chart", async () => {
    const { html } = await page("kind=album", "refused");
    expect(hrefsOf(html)).toContain("/charts?kind=album");
  });

  it("works for the artist and album charts too", async () => {
    for (const kind of ["artist", "album"]) {
      const { res, html } = await page(`kind=${kind}`, "refused");
      expect(res.status).toBe(503);
      expect(textOf(html)).toContain("Charts are unavailable");
    }
  });
});

describe("the week still running", () => {
  // This copy of the site talks to a stand-in that answers with fixed weeks, because the real database
  // reads its own clock. The cutoff is Eastern midnight one day back, so the first play of the running week
  // is counted from Wednesday 00:00 Eastern, and on a Monday or a Tuesday there is no such chart.
  // track: first week 2026-11-02, latest 2026-11-23, current 2026-11-23   (latest is the running week)
  // artist: first = latest = current = 2026-11-23                          (the running week is the only one)
  // album: first 2026-11-09, latest 2026-11-16, current 2026-11-23        (latest is finished)
  it("opens on the week before when the latest week is still running", async () => {
    const { html } = await page("", "inProgress");
    expect(textOf(/<caption[^>]*>([\s\S]*?)<\/caption>/.exec(html)![1]!)).toContain("Nov 16 – Nov 22, 2026");
    expect(rowsOf(html)[0]!.cells[2]!.text).toContain("Stand-in 2026-11-16");
    expect(textOf(html).toLowerCase()).not.toContain("week in progress");
  });

  it("offers the running week as the next one, and shows it flagged when asked for", async () => {
    const before = await page("", "inProgress");
    expect(hrefsOf(before.html)).toContain("/charts?week=2026-11-23");
    const { html } = await page("week=2026-11-23", "inProgress");
    expect(textOf(/<caption[^>]*>([\s\S]*?)<\/caption>/.exec(html)![1]!)).toContain("Nov 23 – Nov 29, 2026");
    expect(rowsOf(html)[0]!.cells[2]!.text).toContain("Stand-in 2026-11-23");
    expect(textOf(html).toLowerCase()).toContain("week in progress");
  });

  it("labels the running week \"so far\" in the week list, and no other week", async () => {
    const { html } = await page("week=2026-11-23", "inProgress");
    const form = elementOf(html, "form", /method="get"/i)!;
    const labels = [...form.matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/g)].map((m) => textOf(m[1] ?? ""));
    expect(labels[0]).toBe("Nov 23 – Nov 29, 2026 (so far)");
    expect(labels.filter((label) => label.includes("(so far)"))).toHaveLength(1);
    expect(form).not.toContain("(in progress)");
  });

  it("opens on the running week, with a note, when it is the only week", async () => {
    const { html } = await page("kind=artist", "inProgress");
    expect(textOf(/<caption[^>]*>([\s\S]*?)<\/caption>/.exec(html)![1]!)).toContain("Nov 23 – Nov 29, 2026");
    expect(rowsOf(html)[0]!.cells[2]!.text).toContain("Stand-in 2026-11-23");
    expect(textOf(html).toLowerCase()).toContain("week in progress");
    const form = elementOf(html, "form", /method="get"/i)!;
    expect([...form.matchAll(/<option\b/g)]).toHaveLength(1);
    expect(hrefsOf(html)).not.toContain("/charts?kind=artist&week=2026-11-16");
  });

  it("opens on the latest week when it is finished", async () => {
    const { html } = await page("kind=album", "inProgress");
    expect(textOf(/<caption[^>]*>([\s\S]*?)<\/caption>/.exec(html)![1]!)).toContain("Nov 16 – Nov 22, 2026");
    expect(rowsOf(html)[0]!.cells[2]!.text).toContain("Stand-in 2026-11-16");
    expect(textOf(html).toLowerCase()).not.toContain("week in progress");
  });

  it("refuses a week past the latest with 404", async () => {
    const { res, html } = await page("kind=album&week=2026-11-23", "inProgress");
    expect(res.status).toBe(404);
    expect(tableOf(html)).toBeNull();
  });
});

/** A date written YYYY-MM-DD, moved by a number of days. */
function addDay(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (path: string) => {
    for (const entry of readDirSafe(path)) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|css)$/.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function readDirSafe(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}
