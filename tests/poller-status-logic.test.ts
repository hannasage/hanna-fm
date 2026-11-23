import { describe, expect, it } from "vitest";
import {
  LOGIN_LIFETIME_DAYS,
  LOGIN_WARN_DAYS,
  STALE_AFTER_HOURS,
  loginHealth,
  pollerStatus,
} from "../src/lib/poller-status";

/**
 * The exact edges, with a fixed clock. The HTTP tests cannot hit an exact millisecond,
 * because the route reads the real clock. A caller of the route can never set this clock.
 */
const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("the settings", () => {
  it("are the agreed numbers, in one place", () => {
    expect(STALE_AFTER_HOURS).toBe(2);
    expect(LOGIN_WARN_DAYS).toBe(150);
    expect(LOGIN_LIFETIME_DAYS).toBe(180);
  });
});

describe("pollerStatus at the exact edges", () => {
  const ok = (agoMs: number) => ({ outcome: "ok" as const, finishedAt: NOW - agoMs, failureKind: null });

  it("is ok at exactly two hours and stale one millisecond later", () => {
    expect(pollerStatus({ latest: ok(2 * HOUR), newestOk: ok(2 * HOUR), lastFailure: null }, NOW).status).toBe("ok");
    expect(pollerStatus({ latest: ok(2 * HOUR + 1), newestOk: ok(2 * HOUR + 1), lastFailure: null }, NOW).status).toBe("stale");
  });

  it("treats an ok run that finished in the future as fresh", () => {
    expect(pollerStatus({ latest: ok(-HOUR), newestOk: ok(-HOUR), lastFailure: null }, NOW).status).toBe("ok");
  });

  it("is no_runs with no latest run", () => {
    expect(pollerStatus({ latest: null, newestOk: null, lastFailure: null }, NOW)).toEqual({
      status: "no_runs",
      last_ok_at: null,
      last_failure: null,
    });
  });
});

describe("loginHealth at the exact edges", () => {
  const at = (days: number, extraMs = 0) => new Date(NOW - days * DAY - extraMs).toISOString();

  it.each<[string, string, string, number]>([
    ["one millisecond under 150 days", at(150, -1), "ok", 149],
    ["exactly 150 days", at(150), "expiring", 150],
    ["one millisecond under 180 days", at(180, -1), "expiring", 179],
    ["exactly 180 days", at(180), "expired", 180],
  ])("reads %s", (_label, value, state, days) => {
    expect(loginHealth(value, NOW)).toEqual({ state, days_since_authorized: days });
  });

  it("reads the present moment as zero days and ok", () => {
    expect(loginHealth(new Date(NOW).toISOString(), NOW)).toEqual({ state: "ok", days_since_authorized: 0 });
  });

  it("is unknown for one millisecond in the future", () => {
    expect(loginHealth(new Date(NOW + 1).toISOString(), NOW)).toEqual({
      state: "unknown",
      days_since_authorized: null,
    });
  });

  it.each([null, undefined, "", " ", "soon", "2026-02-30", "2026-13-01", "2026-06-01T25:00:00Z", "20260601", "0", "1e9"])(
    "is unknown for %j",
    (value) => {
      expect(loginHealth(value, NOW)).toEqual({ state: "unknown", days_since_authorized: null });
    },
  );

  it("reads a plain date as midnight UTC, and trims spaces around it", () => {
    expect(loginHealth("2026-11-22", NOW)).toEqual({ state: "ok", days_since_authorized: 1 });
    expect(loginHealth(" 2026-11-22 ", NOW)).toEqual({ state: "ok", days_since_authorized: 1 });
  });
});
