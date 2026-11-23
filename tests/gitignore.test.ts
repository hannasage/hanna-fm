import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function isIgnored(path: string, cwd: string = process.cwd()): boolean {
  try {
    execFileSync("git", ["check-ignore", "--no-index", "-q", path], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch (error) {
    // `git check-ignore` exits 1 when the path is not ignored. Any other exit is a real failure.
    if ((error as { status?: number | null }).status === 1) return false;
    throw error;
  }
}

describe("git ignore rules", () => {
  it.each([
    ".env",
    ".env.local",
    ".env.production",
    "data/anything.txt",
    "exports/anything.txt",
    "export/anything.txt",
    "data/nested/file.bin",
    "StreamingHistory_music_0.json",
    "Streaming_History_Audio_2020_0.json",
    "my_spotify_data.zip",
    "dump.zip",
    "history.csv",
    "history.tsv",
    "events.ndjson",
    "events.jsonl",
    "library-export.json",
    "full.export.json",
    "backup.dump",
    "backup.sql.gz",
    "supabase/.temp/project-ref",
    "supabase/.branches/_current_branch",
    "supabase/.env",
    "node_modules/pkg/index.js",
    ".next/build-manifest.json",
    "YourLibrary.json",
    "Playlist1.json",
    "Playlist_summer.json",
    "Userdata.json",
    "archive.tar.gz",
    "archive.tgz",
    "archive.7z",
    "report.xlsx",
    "tracks.parquet",
    "notes.bak",
    "config.json.bak",
    ".envrc",
    "cert.p12",
    "cert.pfx",
    "scratch.sql",
    "supabase/dump.sql",
    "supabase/migrations/notes.txt.sql.bak",
    "supabase/snapshots/backup.sql",
  ])("ignores %s", (path) => {
    expect(isIgnored(path)).toBe(true);
  });

  it.each([
    ".env.example",
    "package.json",
    "tsconfig.json",
    "supabase/config.toml",
    "supabase/seed.sql",
    "supabase/migrations/20260101000000_init.sql",
    "supabase/migrations/20261123000000_health_check.sql",
    "src/app/api/health/route.ts",
  ])("does not ignore %s", (path) => {
    expect(isIgnored(path)).toBe(false);
  });
});

describe("the ignore check itself", () => {
  it("rethrows when git fails for a reason other than 'not ignored'", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "hanna-fm-not-a-repo-"));
    try {
      expect(() => isIgnored(".env", notARepo)).toThrow();
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});
