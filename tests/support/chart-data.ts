import { createHash } from "node:crypto";
import { Client } from "pg";
import { expect } from "vitest";
import { testEnv } from "./env";

/**
 * Synthetic plays and helpers shared by the chart test files.
 * Every row here is made up. Rows go in with the service role and come out again after each test.
 */
const env = testEnv();

export type Play = {
  track_uri: string;
  track_name: string;
  artist_name: string;
  album_name: string | null;
  ended_at: string;
  ms_played: number | null;
  source: "export" | "poll";
};

export type ChartRow = {
  rank: number;
  key: string;
  name: string;
  plays: number;
  minutes: number;
  last_week_rank: number | null;
  peak_rank: number;
  weeks_on_chart: number;
};

export type Chart = { week_start: string | null; kind: string; rows: ChartRow[]; status?: string };

export function play(track: string, endedAt: string, overrides: Partial<Play> = {}): Play {
  return {
    track_uri: `spotify:track:synthetic-${track}`,
    track_name: `Track ${track}`,
    artist_name: `Artist ${track}`,
    album_name: `Album ${track}`,
    ended_at: new Date(endedAt).toISOString(),
    ms_played: 200_000,
    source: "export",
    ...overrides,
  };
}

/** `n` plays of one track, one minute apart from the start time, so no two clash. */
export function plays(track: string, n: number, startIso: string, overrides: Partial<Play> = {}): Play[] {
  const start = new Date(startIso).getTime();
  return Array.from({ length: n }, (_, i) =>
    play(track, new Date(start + i * 60_000).toISOString(), overrides),
  );
}

export function serviceHeaders(extra: Record<string, string> = {}) {
  return {
    apikey: env.serviceRoleKey,
    Authorization: `Bearer ${env.serviceRoleKey}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

export async function insertPlays(rows: Play[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const res = await fetch(`${env.apiUrl}/rest/v1/plays`, {
      method: "POST",
      headers: serviceHeaders(),
      body: JSON.stringify(rows.slice(i, i + 500)),
    });
    expect(res.status).toBe(201);
  }
}

export async function clearPlays() {
  const res = await fetch(`${env.apiUrl}/rest/v1/plays?id=gte.0`, {
    method: "DELETE",
    headers: serviceHeaders(),
  });
  expect(res.status).toBe(204);
}

/** Runs a callback with a direct database connection, and always closes it. */
export async function withDb<T>(run: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  try {
    return await run(db);
  } finally {
    await db.end();
  }
}

/** The key the database gives an album chart row: one hash for the album, one for the artist. */
export function albumKey(album: string, artist: string): string {
  const md5 = (text: string) => createHash("md5").update(text, "utf8").digest("hex");
  return `${md5(album)}.${md5(artist)}`;
}
