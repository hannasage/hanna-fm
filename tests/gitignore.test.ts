import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function isIgnored(path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "--no-index", "-q", path], {
      cwd: process.cwd(),
    });
    return true;
  } catch {
    return false;
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
    "src/app/api/health/route.ts",
  ])("does not ignore %s", (path) => {
    expect(isIgnored(path)).toBe(false);
  });
});
