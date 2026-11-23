import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The fixture export file. It copies the row format the ingest repository assumes in its
 * `src/mapping.ts`. Those key names are guesses that no real export has confirmed yet.
 */
const DIR = join(process.cwd(), "fixtures", "fake-export");
const FILE = "fake-extended-history.json";

/** Every key `src/mapping.ts` in the ingest repository reads: stored columns first, then the drop signals. */
const READ_KEYS = [
  "spotify_track_uri",
  "master_metadata_track_name",
  "master_metadata_album_artist_name",
  "master_metadata_album_album_name",
  "ts",
  "ms_played",
  "episode_name",
  "spotify_episode_uri",
  "incognito_mode",
];

/** Private fields a real export carries. None may appear, not even with a dummy value. */
const PRIVATE_KEYS = [
  "ip_addr",
  "ip_addr_decrypted",
  "conn_country",
  "platform",
  "user_agent_decrypted",
  "username",
  "offline",
  "offline_timestamp",
];

type Row = Record<string, unknown>;
const rows = JSON.parse(readFileSync(join(DIR, FILE), "utf8")) as Row[];

describe("fake export fixture", () => {
  it("is a list of rows", () => {
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(30);
  });

  it("holds only keys the ingest mapping reads", () => {
    for (const row of rows) {
      for (const key of Object.keys(row)) expect(READ_KEYS, key).toContain(key);
    }
  });

  it("leaves private fields out entirely", () => {
    const text = readFileSync(join(DIR, FILE), "utf8");
    for (const key of PRIVATE_KEYS) expect(text).not.toContain(`"${key}"`);
    expect(text).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("writes every time as an ISO instant ending in Z", () => {
    for (const row of rows) expect(String(row.ts)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("uses obviously fake names", () => {
    for (const row of rows) {
      if (row.episode_name) {
        expect(row.episode_name).toMatch(/^Fake Episode \d+$/);
        expect(String(row.spotify_episode_uri)).toMatch(/^spotify:episode:fake\d+$/);
      } else {
        expect(row.master_metadata_track_name).toMatch(/^Fake Track \d+$/);
        expect(row.master_metadata_album_artist_name).toMatch(/^Fake Artist \d+$/);
        expect(String(row.spotify_track_uri)).toMatch(/^spotify:track:fake\d+$/);
        if (row.master_metadata_album_album_name !== null) {
          expect(row.master_metadata_album_album_name).toMatch(/^Fake Album \d+$/);
        }
      }
    }
  });

  it("holds each kind of row the importer must handle", () => {
    expect(rows.some((r) => r.episode_name)).toBe(true);
    expect(rows.some((r) => r.incognito_mode === true)).toBe(true);
    expect(rows.some((r) => !r.episode_name && r.master_metadata_album_album_name === null)).toBe(true);
    expect(rows.some((r) => typeof r.ms_played === "number" && r.ms_played < 30_000)).toBe(true);
    expect(rows.some((r) => typeof r.ms_played === "number" && r.ms_played >= 30_000)).toBe(true);
  });

  it("never repeats a track and time", () => {
    const keys = rows.filter((r) => !r.episode_name).map((r) => `${r.spotify_track_uri}|${r.ts}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("says in its README that the keys are unverified guesses and the data is fake", () => {
    const readme = readFileSync(join(DIR, "README.md"), "utf8");
    expect(readme).toMatch(/unverified/i);
    expect(readme).toMatch(/guess/i);
    expect(readme).toMatch(/fake/i);
  });

  it("is not ignored by git, so it can be committed", () => {
    expect(() =>
      execFileSync("git", ["check-ignore", "--no-index", "-q", `fixtures/fake-export/${FILE}`], {
        stdio: "ignore",
      }),
    ).toThrowError(expect.objectContaining({ status: 1 }));
  });
});
