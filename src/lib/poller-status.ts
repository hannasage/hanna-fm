import { PollerStatusShapeError } from "./failure-reason";

/**
 * The poller health rules. Pure: no database, no clock. The route passes in the time it read,
 * so a caller of the route can never set the clock.
 */

/** A newest ok run older than this many hours makes the poller stale. */
export const STALE_AFTER_HOURS = 2;
/** From this many days after the Spotify login, the login is expiring. */
export const LOGIN_WARN_DAYS = 150;
/** Spotify's refresh token lasts six months from authorization. At this many days it is expired. */
export const LOGIN_LIFETIME_DAYS = 180;
/** The poller_state key that holds the date or instant of the last Spotify authorization. */
export const LOGIN_STATE_KEY = "spotify_authorized_at";
/** With no ok run that stored a play for this many days, the feed may be running but empty. */
export const STORE_QUIET_DAYS = 7;
/** A run that finished more than this many minutes ahead of the clock is a clock fault. */
export const CLOCK_SKEW_MINUTES = 5;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const CLOCK_SKEW_MS = CLOCK_SKEW_MINUTES * 60_000;

/** The latest finish time a run may have and still be trusted, for a clock reading of `now`. */
export function newestTrustedFinish(now: number): number {
  return now + CLOCK_SKEW_MS;
}

export type PollerRun = {
  outcome: "ok" | "failed";
  /** Milliseconds since the epoch. */
  finishedAt: number;
  failureKind: string | null;
};

export type PollerRuns = {
  /** The run that finished last, of either outcome. */
  latest: PollerRun | null;
  /** The ok run that finished last. */
  newestOk: PollerRun | null;
  /** The failed run that finished last. */
  lastFailure: PollerRun | null;
  /** The ok run that finished last and stored more than zero plays. */
  lastStored: PollerRun | null;
};

export type PollerRunStatus = {
  status: "no_runs" | "ok" | "stale" | "failing";
  last_ok_at: string | null;
  last_failure: { at: string; kind: string } | null;
  last_stored_at: string | null;
};

export type LoginHealth = {
  state: "unknown" | "ok" | "expiring" | "expired";
};

/** The fixed strings the `attention` array may hold, in the order they are listed. */
export type Attention =
  | "login_unknown"
  | "login_expiring"
  | "login_expired"
  | "no_stores_recently"
  | "clock_skew";

export type PollerHealth = PollerRunStatus & {
  login: LoginHealth;
  attention: Attention[];
};

/** True when a run finished more than the allowed skew ahead of the clock. */
function isAhead(run: PollerRun | null, now: number): boolean {
  return run !== null && run.finishedAt > newestTrustedFinish(now);
}

/** A run the clock can trust, or null. A run ahead of the clock is ignored. */
function trusted(run: PollerRun | null, now: number): PollerRun | null {
  return run === null || isAhead(run, now) ? null : run;
}

const iso = (run: PollerRun | null): string | null =>
  run ? new Date(run.finishedAt).toISOString() : null;

export function pollerStatus(allRuns: PollerRuns, now: number): PollerRunStatus {
  const runs: PollerRuns = {
    latest: trusted(allRuns.latest, now),
    newestOk: trusted(allRuns.newestOk, now),
    lastFailure: trusted(allRuns.lastFailure, now),
    lastStored: trusted(allRuns.lastStored, now),
  };
  // After a success the poller may still hold an older failure, so both fields are always filled.
  const okRun = runs.newestOk ?? (runs.latest?.outcome === "ok" ? runs.latest : null);
  const last_ok_at = iso(okRun);
  const last_stored_at = iso(runs.lastStored);
  const last_failure =
    runs.lastFailure && runs.lastFailure.failureKind !== null
      ? { at: new Date(runs.lastFailure.finishedAt).toISOString(), kind: runs.lastFailure.failureKind }
      : null;

  if (!runs.latest) return { status: "no_runs", last_ok_at, last_failure, last_stored_at };
  // A failure now outranks a late success, because it says why the poller is behind.
  if (runs.latest.outcome === "failed") return { status: "failing", last_ok_at, last_failure, last_stored_at };
  const stale = okRun !== null && now - okRun.finishedAt > STALE_AFTER_HOURS * HOUR_MS;
  return { status: stale ? "stale" : "ok", last_ok_at, last_failure, last_stored_at };
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Milliseconds for a date (midnight UTC) or an ISO instant with a zone. Anything else is null. */
function readMoment(value: string): number | null {
  const match = DATE_ONLY.exec(value) ?? INSTANT.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const probe = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  // Date rolls 30 February over to March, so the calendar day must survive the round trip.
  if (
    probe.getUTCFullYear() !== Number(year) ||
    probe.getUTCMonth() !== Number(month) - 1 ||
    probe.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  const ms = DATE_ONLY.test(value) ? probe.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * `unknown` means the key is absent. A value that is there but unreadable, or in the future,
 * cannot be trusted, and it is `expiring` so that someone looks at it.
 */
export function loginHealth(value: string | null | undefined, now: number): LoginHealth {
  if (value === null || value === undefined) return { state: "unknown" };
  const authorizedAt = typeof value === "string" ? readMoment(value.trim()) : null;
  if (authorizedAt === null || authorizedAt > now) return { state: "expiring" };
  const days = Math.floor((now - authorizedAt) / DAY_MS);
  const state =
    days >= LOGIN_LIFETIME_DAYS ? "expired" : days >= LOGIN_WARN_DAYS ? "expiring" : "ok";
  return { state };
}

export type PollerHealthInput = {
  runs: PollerRuns;
  /** The stored login value, or null when the key is absent. */
  loginValue: string | null;
  /** True when the route found a run ahead of the clock, which its queries leave out. */
  futureRunSeen: boolean;
};

/** Everything the route reports, from the rows it read and one reading of the clock. */
export function pollerHealth(input: PollerHealthInput, now: number): PollerHealth {
  const run = pollerStatus(input.runs, now);
  const login = loginHealth(input.loginValue, now);
  const attention: Attention[] = [];

  if (login.state === "unknown") attention.push("login_unknown");
  if (login.state === "expiring") attention.push("login_expiring");
  if (login.state === "expired") attention.push("login_expired");

  // Only a poller that is otherwise ok can be quiet. A stale or failing one has a worse flag already.
  if (run.status === "ok") {
    const stored = run.last_stored_at === null ? null : Date.parse(run.last_stored_at);
    if (stored === null || now - stored > STORE_QUIET_DAYS * DAY_MS) {
      attention.push("no_stores_recently");
    }
  }

  const skew =
    input.futureRunSeen ||
    [input.runs.latest, input.runs.newestOk, input.runs.lastFailure, input.runs.lastStored].some((r) =>
      isAhead(r, now),
    );
  if (skew) attention.push("clock_skew");

  return { ...run, login, attention };
}

/**
 * 503 when the poller is behind (stale, failing, or no runs) or the login is expired, so a
 * monitor on the status code raises an alarm. Every other case is 200, warnings included.
 */
export function httpStatusFor(health: PollerHealth): 200 | 503 {
  return health.status !== "ok" || health.login.state === "expired" ? 503 : 200;
}

/**
 * Turns the rows the database sent for one run query into a run, or null for no row.
 * A row that is not what the table promises is a fault, not a quiet poller.
 */
export function toPollerRun(data: unknown): PollerRun | null {
  if (!Array.isArray(data) || data.length > 1) throw new PollerStatusShapeError();
  if (data.length === 0) return null;
  const row = data[0] as Record<string, unknown> | null;
  if (typeof row !== "object" || row === null) throw new PollerStatusShapeError();
  const { outcome, finished_at, failure_kind } = row;
  if (outcome !== "ok" && outcome !== "failed") throw new PollerStatusShapeError();
  if (typeof finished_at !== "string") throw new PollerStatusShapeError();
  const finishedAt = Date.parse(finished_at);
  if (Number.isNaN(finishedAt)) throw new PollerStatusShapeError();
  if (outcome === "failed" && typeof failure_kind !== "string") throw new PollerStatusShapeError();
  return { outcome, finishedAt, failureKind: typeof failure_kind === "string" ? failure_kind : null };
}

/** The stored value of one state key, or null when the key is absent. */
export function toStateValue(data: unknown): string | null {
  if (!Array.isArray(data) || data.length > 1) throw new PollerStatusShapeError();
  if (data.length === 0) return null;
  const row = data[0] as Record<string, unknown> | null;
  if (typeof row !== "object" || row === null || typeof row.value !== "string") {
    throw new PollerStatusShapeError();
  }
  return row.value;
}
