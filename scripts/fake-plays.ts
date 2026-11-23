/**
 * Fake listening history for local work. Every name here is invented and obviously fake.
 * Nothing in this file reads the clock, the network or the database, so the output is
 * the same for the same day and seed. The site never imports this file.
 *
 * The shape is planned, not random, so the newest completed weeks (1 to 3 weeks back) show every
 * chart case on all three charts:
 *   - Fake Artist 01: two tracks, one steady and one that climbs one step a week until it takes number one
 *   - Fake Artist 02: peaks early at number one, then falls. One of its tracks leaves the chart and comes back
 *   - Fake Artist 03: a track that is NEW three weeks back, beside one that stays on the chart
 *   - Fake Artist 04: leaves the chart for five weeks and comes back (RE-ENTRY), then climbs
 *   - Fake Artist 05: appears two weeks back and never played before (NEW)
 *   - thirty background tracks with small, noisy weekly counts, some with no album
 * Each of these artists has one album with the same number, so the album chart tells the same story.
 * Chart weeks run Monday to Sunday in America/New_York, so the plan is written in weeks.
 *
 * The featured tracks never play on a Sunday. The public delay hides the previous day, so on a Monday
 * the newest completed week loses its Sunday. With none of its plays on Sunday, that week's chart is
 * the same on every day the site can be opened. Background tracks do play on Sunday.
 */

export type FakePlay = {
  track_uri: string;
  track_name: string;
  artist_name: string;
  album_name: string | null;
  ended_at: string;
  ms_played: number | null;
  source: "export" | "poll";
};

export const FAKE_SEED = 20261123;

/** Weeks back from the current week. The oldest is 104 weeks back, so the history is about two years. */
const WEEKS = 104;
/** Plays from this many days before the current Monday onward come from the poller, which never learns how long a play ran. */
const POLL_DAYS_BEFORE_MONDAY = 4;
/** Plays a track can have on one day, which is how many 47 minute time slots fit before the day ends. */
const MAX_SLOTS_PER_DAY = 10;

/** The refused address is never named, so a hosted project reference cannot reach a log. */
export class SeedRefusedError extends Error {
  constructor(reason: string) {
    super(`Refused: ${reason}`);
    this.name = "SeedRefusedError";
  }
}

/** Returns the parsed address when it points at this computer, and refuses every other. */
export function assertLocalUrl(text: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new SeedRefusedError("the Supabase address is not a valid URL.");
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!local || (url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new SeedRefusedError("the Supabase address is not local (127.0.0.1 or localhost). Fake plays go to the local stack only.");
  }
  return url;
}

/** The calendar date in New York, as YYYY-MM-DD. */
export function easternDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function dayNumber(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / 86_400_000;
}

function dateOf(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/** mulberry32: a small seeded random number generator. It returns numbers in [0, 1). */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Track = {
  uri: string;
  name: string;
  artist: string;
  album: string | null;
  durationMs: number;
  /** How many days of the week the track plays on: 6 is Monday to Saturday, 7 is every day. */
  days: 6 | 7;
  /** Counted plays in the week that began `weeksBack` weeks before the current one. */
  plays: (weeksBack: number) => number;
};

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/**
 * A track whose counts are written out week by week for the 12 newest completed weeks.
 * Older weeks use `older`, a week missing from the table counts 0, and the current week copies the newest completed one.
 */
function planned(older: number, byWeeksBack: Record<number, number>): (weeksBack: number) => number {
  return (weeksBack) => {
    if (weeksBack === 0) return byWeeksBack[1] ?? older;
    return byWeeksBack[weeksBack] ?? (weeksBack > 12 ? older : 0);
  };
}

/**
 * Eight tracks that fix the chart cases, as [artist and album number, plan]. Counts per week, weeks back 12 down to 1.
 * Background tracks never pass 3 plays a week, so a background artist stays under 17 plays and these rank above it.
 */
function featuredPlans(): [number, (weeksBack: number) => number][] {
  return [
    // Fake Artist 01. Steady at the top.
    [1, () => 30],
    // Climbs one step a week, passes the faller, then takes number one two weeks back.
    [1, planned(8, { 12: 12, 11: 13, 10: 15, 9: 17, 8: 19, 7: 21, 6: 23, 5: 25, 4: 27, 3: 29, 2: 31, 1: 33 })],
    // Fake Artist 02. Enters at number two and peaks there, then slips. It never goes under 9 plays.
    [2, planned(0, { 12: 29, 11: 27, 10: 25, 9: 23, 8: 21, 7: 19, 6: 17, 5: 15, 4: 13, 3: 11, 2: 10, 1: 9 })],
    // On the chart, off the chart for five weeks, then back (RE-ENTRY three weeks back).
    [2, planned(0, { 12: 18, 11: 18, 10: 17, 9: 16, 3: 19, 2: 18, 1: 18 })],
    // Fake Artist 03. First seen three weeks back (NEW), beside a track that stays near the top.
    [3, planned(0, { 3: 20, 2: 22, 1: 21 })],
    [3, () => 14],
    // Fake Artist 04. Gone for five weeks, back three weeks back (RE-ENTRY), then climbs past Fake Artist 02.
    [4, planned(0, { 12: 16, 11: 16, 10: 15, 9: 15, 3: 15, 2: 20, 1: 29 })],
    // Fake Artist 05. Never played before two weeks back (NEW).
    [5, planned(0, { 2: 17, 1: 18 })],
  ];
}

function buildRoster(rand: () => number): Track[] {
  const roster: Track[] = [];
  let trackNumber = 0;
  const add = (artistNo: number, albumNo: number | null, days: Track["days"], plays: Track["plays"]) => {
    trackNumber += 1;
    roster.push({
      uri: `spotify:track:fake${pad(trackNumber, 4)}`,
      name: `Fake Track ${pad(trackNumber, 3)}`,
      artist: `Fake Artist ${pad(artistNo)}`,
      album: albumNo === null ? null : `Fake Album ${pad(albumNo)}`,
      durationMs: 150_000 + Math.floor(rand() * 150_000),
      days,
      plays,
    });
  };

  for (const [artistNo, plan] of featuredPlans()) add(artistNo, artistNo, 6, plan);

  // Thirty background tracks on artists 6 to 12. Artists 11 and 12 have no albums at all, and one more track has none.
  for (let j = 0; j < 30; j++) {
    const artistNo = 6 + (j % 7);
    const albumNo = artistNo >= 11 || j === 7 ? null : artistNo;
    const startsWeeksBack = j < 10 ? WEEKS : WEEKS - j * 3;
    const base = 1 + (j % 3);
    const noise = Array.from({ length: WEEKS + 1 }, () => Math.floor(rand() * 3) - 1);
    add(artistNo, albumNo, 7, (weeksBack) => {
      if (weeksBack > startsWeeksBack) return 0;
      return Math.min(3, Math.max(0, base + noise[weeksBack]!));
    });
  }
  return roster;
}

/** A fake play and the New York calendar day the plan put it on. */
export type PlannedPlay = { play: FakePlay; day: string };

/**
 * Plays for the history that ends the day before `today` (an Eastern date, YYYY-MM-DD).
 * The plan hangs from the Monday of the current Eastern week, so two runs in the same week agree
 * on every play they share, and a run on a later day only adds the days since.
 *
 * Every play lands between 13:00 and 23:00 UTC (skips at 13:xx, the rest from 14:00 on). That is the same
 * calendar day in New York in every season, so no play moves to another chart day when the clocks change.
 */
export function generatePlannedPlays(options: { today: string; seed?: number }): PlannedPlay[] {
  const rand = prng(options.seed ?? FAKE_SEED);
  const today = dayNumber(options.today);
  const weekday = (today + 3) % 7; // 1970-01-01 was a Thursday: Monday = 0.
  const monday = today - weekday;
  const pollFrom = monday - POLL_DAYS_BEFORE_MONDAY;
  const roster = buildRoster(rand);
  const plays: PlannedPlay[] = [];

  for (let weeksBack = WEEKS; weeksBack >= 0; weeksBack--) {
    const weekStart = monday - weeksBack * 7;
    roster.forEach((track, trackIndex) => {
      const count = track.plays(weeksBack);
      if (count > MAX_SLOTS_PER_DAY * track.days) throw new Error("A week holds more plays than the time slots allow.");
      const dayShift = Math.floor(rand() * track.days);
      // Every random number is drawn before a play is dropped, so the run day never shifts the others.
      for (let i = 0; i < count; i++) {
        const day = weekStart + ((i + dayShift) % track.days);
        const slot = Math.floor(i / track.days);
        // Each slot owns its own 47 minute window, so two plays of one track never share a time.
        const seconds = (slot * 47 + Math.floor(rand() * 41)) * 60 + Math.floor(rand() * 60);
        const shortfall = Math.floor(rand() * 20_000);
        if (day >= today) continue;
        const instant = day * 86_400_000 + 14 * 3_600_000 + seconds * 1000;
        const poll = day >= pollFrom;
        plays.push({
          play: toPlay(track, instant, poll ? null : Math.max(30_000, track.durationMs - shortfall), poll),
          day: dateOf(day),
        });
      }
      // Two short plays on a few tracks each week: skips the chart must not count.
      if ((trackIndex + weeksBack) % 5 === 0) {
        for (let i = 0; i < 2; i++) {
          const day = weekStart + ((dayShift + i * 3) % track.days);
          const minutes = i * 20 + Math.floor(rand() * 20);
          const length = 2_000 + Math.floor(rand() * 27_000);
          if (day >= pollFrom) continue;
          const instant = day * 86_400_000 + 13 * 3_600_000 + minutes * 60_000;
          plays.push({ play: toPlay(track, instant, length, false), day: dateOf(day) });
        }
      }
    });
  }
  return plays.sort((a, b) =>
    a.play.ended_at < b.play.ended_at ? -1 : a.play.ended_at > b.play.ended_at ? 1 : a.play.track_uri < b.play.track_uri ? -1 : 1,
  );
}

export function generateFakePlays(options: { today: string; seed?: number }): FakePlay[] {
  return generatePlannedPlays(options).map((planned) => planned.play);
}

function toPlay(track: Track, instant: number, msPlayed: number | null, poll: boolean): FakePlay {
  return {
    track_uri: track.uri,
    track_name: track.name,
    artist_name: track.artist,
    album_name: track.album,
    ended_at: new Date(instant).toISOString(),
    ms_played: msPlayed,
    source: poll ? "poll" : "export",
  };
}
