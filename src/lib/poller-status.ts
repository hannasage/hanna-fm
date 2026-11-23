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

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

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
};

export type PollerRunStatus = {
  status: "no_runs" | "ok" | "stale" | "failing";
  last_ok_at: string | null;
  last_failure: { at: string; kind: string } | null;
};

export type LoginHealth = {
  state: "unknown" | "ok" | "expiring" | "expired";
  days_since_authorized: number | null;
};

export function pollerStatus(runs: PollerRuns, now: number): PollerRunStatus {
  // After a success the poller may still hold an older failure, so both fields are always filled.
  const okRun = runs.newestOk ?? (runs.latest?.outcome === "ok" ? runs.latest : null);
  const last_ok_at = okRun ? new Date(okRun.finishedAt).toISOString() : null;
  const last_failure =
    runs.lastFailure && runs.lastFailure.failureKind !== null
      ? { at: new Date(runs.lastFailure.finishedAt).toISOString(), kind: runs.lastFailure.failureKind }
      : null;

  if (!runs.latest) return { status: "no_runs", last_ok_at, last_failure };
  // A failure now outranks a late success, because it says why the poller is behind.
  if (runs.latest.outcome === "failed") return { status: "failing", last_ok_at, last_failure };
  const stale = okRun !== null && now - okRun.finishedAt > STALE_AFTER_HOURS * HOUR_MS;
  return { status: stale ? "stale" : "ok", last_ok_at, last_failure };
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

export function loginHealth(value: string | null | undefined, now: number): LoginHealth {
  const unknown: LoginHealth = { state: "unknown", days_since_authorized: null };
  if (typeof value !== "string") return unknown;
  const authorizedAt = readMoment(value.trim());
  // A date in the future cannot be a real authorization, so it is not trusted.
  if (authorizedAt === null || authorizedAt > now) return unknown;
  const days = Math.floor((now - authorizedAt) / DAY_MS);
  const state =
    days >= LOGIN_LIFETIME_DAYS ? "expired" : days >= LOGIN_WARN_DAYS ? "expiring" : "ok";
  return { state, days_since_authorized: days };
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
