import { describe, expect, it } from "vitest";
import {
  CLOCK_SKEW_MINUTES,
  LOGIN_LIFETIME_DAYS,
  LOGIN_WARN_DAYS,
  STALE_AFTER_HOURS,
  STORE_QUIET_DAYS,
  httpStatusFor,
  loginHealth,
  pollerHealth,
  pollerStatus,
} from "../src/lib/poller-status";

/**
 * The exact edges, with a fixed clock. The HTTP tests cannot hit an exact millisecond,
 * because the route reads the real clock. A caller of the route can never set this clock.
 */
const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MINUTE = 60_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describe("the settings", () => {
  it("are the agreed numbers, in one place", () => {
    expect(STALE_AFTER_HOURS).toBe(2);
    expect(LOGIN_WARN_DAYS).toBe(150);
    expect(LOGIN_LIFETIME_DAYS).toBe(180);
    expect(STORE_QUIET_DAYS).toBe(7);
    expect(CLOCK_SKEW_MINUTES).toBe(5);
  });
});

describe("pollerStatus at the exact edges", () => {
  const ok = (agoMs: number) => ({ outcome: "ok" as const, finishedAt: NOW - agoMs, failureKind: null });
  const runs = (agoMs: number) => ({ latest: ok(agoMs), newestOk: ok(agoMs), lastFailure: null, lastStored: null });

  it("is ok at exactly two hours and stale one millisecond later", () => {
    expect(pollerStatus(runs(2 * HOUR), NOW).status).toBe("ok");
    expect(pollerStatus(runs(2 * HOUR + 1), NOW).status).toBe("stale");
  });

  it("is no_runs with no latest run", () => {
    expect(pollerStatus({ latest: null, newestOk: null, lastFailure: null, lastStored: null }, NOW)).toEqual({
      status: "no_runs",
      last_ok_at: null,
      last_failure: null,
      last_stored_at: null,
    });
  });

  it("gives the finish time of the newest run that stored something", () => {
    const stored = ok(3 * HOUR);
    const result = pollerStatus({ latest: ok(MINUTE), newestOk: ok(MINUTE), lastFailure: null, lastStored: stored }, NOW);

    expect(result.last_stored_at).toBe(new Date(stored.finishedAt).toISOString());
  });
});

describe("a run that finishes ahead of the clock", () => {
  const ok = (aheadMs: number) => ({ outcome: "ok" as const, finishedAt: NOW + aheadMs, failureKind: null });
  const failed = (aheadMs: number) => ({ outcome: "failed" as const, finishedAt: NOW + aheadMs, failureKind: "x" });
  const only = (run: ReturnType<typeof ok>) => ({ latest: run, newestOk: run, lastFailure: null, lastStored: run });

  it("counts as fresh at exactly five minutes ahead", () => {
    expect(pollerStatus(only(ok(5 * MINUTE)), NOW).status).toBe("ok");
    expect(pollerHealth({ runs: only(ok(5 * MINUTE)), loginValue: iso(NOW - DAY), futureRunSeen: false }, NOW).attention)
      .not.toContain("clock_skew");
  });

  it("is ignored one millisecond past five minutes ahead", () => {
    expect(pollerStatus(only(ok(5 * MINUTE + 1)), NOW)).toEqual({
      status: "no_runs",
      last_ok_at: null,
      last_failure: null,
      last_stored_at: null,
    });
  });

  it("is ignored when it is an hour ahead, so it cannot hide a stale poller", () => {
    const older = { outcome: "ok" as const, finishedAt: NOW - 3 * HOUR, failureKind: null };
    const result = pollerStatus({ latest: older, newestOk: older, lastFailure: null, lastStored: null }, NOW);
    expect(result.status).toBe("stale");
    // The route never passes the future run, and the rule holds even if a caller did.
    const withFuture = pollerStatus({ latest: ok(HOUR), newestOk: ok(HOUR), lastFailure: null, lastStored: null }, NOW);
    expect(withFuture.status).toBe("no_runs");
    expect(withFuture.last_ok_at).toBeNull();
  });

  it("ignores a failed run ahead of the clock", () => {
    const result = pollerStatus({ latest: failed(HOUR), newestOk: null, lastFailure: failed(HOUR), lastStored: null }, NOW);
    expect(result).toEqual({ status: "no_runs", last_ok_at: null, last_failure: null, last_stored_at: null });
  });

  it("adds clock_skew to attention, from a run it was given or from the route's own check", () => {
    const given = pollerHealth({ runs: only(ok(HOUR)), loginValue: iso(NOW - DAY), futureRunSeen: false }, NOW);
    const seen = pollerHealth(
      { runs: { latest: null, newestOk: null, lastFailure: null, lastStored: null }, loginValue: null, futureRunSeen: true },
      NOW,
    );

    expect(given.attention).toContain("clock_skew");
    expect(seen.attention).toContain("clock_skew");
  });
});

describe("loginHealth at the exact edges", () => {
  const at = (days: number, extraMs = 0) => new Date(NOW - days * DAY - extraMs).toISOString();

  it.each<[string, string, string]>([
    ["one millisecond under 150 days", at(150, -1), "ok"],
    ["exactly 150 days", at(150), "expiring"],
    ["one millisecond under 180 days", at(180, -1), "expiring"],
    ["exactly 180 days", at(180), "expired"],
  ])("reads %s", (_label, value, state) => {
    expect(loginHealth(value, NOW)).toEqual({ state });
  });

  it("reads the present moment as ok", () => {
    expect(loginHealth(new Date(NOW).toISOString(), NOW)).toEqual({ state: "ok" });
  });

  it("never reports a day count", () => {
    expect(Object.keys(loginHealth(at(160), NOW))).toEqual(["state"]);
  });

  it.each([null, undefined])("is unknown when the key is absent (%j)", (value) => {
    expect(loginHealth(value, NOW)).toEqual({ state: "unknown" });
  });

  it("is expiring for a date one millisecond in the future, so someone looks", () => {
    expect(loginHealth(new Date(NOW + 1).toISOString(), NOW)).toEqual({ state: "expiring" });
  });

  it.each(["", " ", "soon", "2026-02-30", "2026-13-01", "2026-06-01T25:00:00Z", "20260601", "0", "1e9"])(
    "is expiring for the present but unreadable value %j",
    (value) => {
      expect(loginHealth(value, NOW)).toEqual({ state: "expiring" });
    },
  );

  it("reads a plain date as midnight UTC, and trims spaces around it", () => {
    expect(loginHealth("2026-11-22", NOW)).toEqual({ state: "ok" });
    expect(loginHealth(" 2026-11-22 ", NOW)).toEqual({ state: "ok" });
  });
});

describe("pollerHealth", () => {
  const okRun = (agoMs: number) => ({ outcome: "ok" as const, finishedAt: NOW - agoMs, failureKind: null });
  const healthy = { latest: okRun(MINUTE), newestOk: okRun(MINUTE), lastFailure: null, lastStored: okRun(MINUTE) };
  const input = (over: Partial<Parameters<typeof pollerHealth>[0]> = {}) => ({
    runs: healthy,
    loginValue: iso(NOW - DAY),
    futureRunSeen: false,
    ...over,
  });

  it("has an empty attention list when everything is fine", () => {
    const health = pollerHealth(input(), NOW);

    expect(health.attention).toEqual([]);
    expect(health.status).toBe("ok");
    expect(health.login).toEqual({ state: "ok" });
    expect(health.last_stored_at).toBe(new Date(NOW - MINUTE).toISOString());
  });

  it.each<[string | null, string[]]>([
    [null, ["login_unknown"]],
    [iso(NOW - 150 * DAY), ["login_expiring"]],
    ["not a date", ["login_expiring"]],
    [iso(NOW + DAY), ["login_expiring"]],
    [iso(NOW - 180 * DAY), ["login_expired"]],
  ])("maps the login value %j to %j", (loginValue, attention) => {
    expect(pollerHealth(input({ loginValue }), NOW).attention).toEqual(attention);
  });

  it("adds no_stores_recently when nothing was stored, while the status is ok", () => {
    const runs = { ...healthy, lastStored: null };

    expect(pollerHealth(input({ runs }), NOW).attention).toEqual(["no_stores_recently"]);
    expect(pollerHealth(input({ runs }), NOW).last_stored_at).toBeNull();
  });

  it("is quiet for a store exactly seven days old and flags one millisecond more", () => {
    const stored = (agoMs: number) => ({ ...healthy, lastStored: okRun(agoMs) });

    expect(pollerHealth(input({ runs: stored(7 * DAY) }), NOW).attention).toEqual([]);
    expect(pollerHealth(input({ runs: stored(7 * DAY + 1) }), NOW).attention).toEqual(["no_stores_recently"]);
  });

  it("does not add no_stores_recently when the status is not ok", () => {
    const stale = { latest: okRun(3 * HOUR), newestOk: okRun(3 * HOUR), lastFailure: null, lastStored: null };
    const none = { latest: null, newestOk: null, lastFailure: null, lastStored: null };

    expect(pollerHealth(input({ runs: stale }), NOW).attention).toEqual([]);
    expect(pollerHealth(input({ runs: none }), NOW).attention).toEqual([]);
  });

  it("lists attention in a fixed order", () => {
    const runs = { ...healthy, lastStored: null };
    const health = pollerHealth(input({ runs, loginValue: null, futureRunSeen: true }), NOW);

    expect(health.attention).toEqual(["login_unknown", "no_stores_recently", "clock_skew"]);
  });
});

describe("httpStatusFor", () => {
  const okRun = { outcome: "ok" as const, finishedAt: NOW - MINUTE, failureKind: null };
  const runs = { latest: okRun, newestOk: okRun, lastFailure: null, lastStored: okRun };
  const code = (loginValue: string | null, over = {}) =>
    httpStatusFor(pollerHealth({ runs, loginValue, futureRunSeen: false, ...over }, NOW));

  it("is 200 for an ok status, with or without the three warnings", () => {
    expect(code(iso(NOW - DAY))).toBe(200);
    expect(code(null)).toBe(200);
    expect(code(iso(NOW - 160 * DAY))).toBe(200);
    expect(code(iso(NOW - DAY), { runs: { ...runs, lastStored: null } })).toBe(200);
  });

  it("is 200 with a clock_skew warning when the status is ok", () => {
    expect(code(iso(NOW - DAY), { futureRunSeen: true })).toBe(200);
  });

  it("is 503 when the login is expired", () => {
    expect(code(iso(NOW - 180 * DAY))).toBe(503);
  });

  it.each<[string, Parameters<typeof pollerHealth>[0]["runs"]]>([
    ["stale", { latest: { ...okRun, finishedAt: NOW - 3 * HOUR }, newestOk: { ...okRun, finishedAt: NOW - 3 * HOUR }, lastFailure: null, lastStored: null }],
    ["failing", { latest: { outcome: "failed", finishedAt: NOW - MINUTE, failureKind: "x" }, newestOk: okRun, lastFailure: null, lastStored: okRun }],
    ["no_runs", { latest: null, newestOk: null, lastFailure: null, lastStored: null }],
  ])("is 503 when the status is %s", (_label, badRuns) => {
    expect(code(iso(NOW - DAY), { runs: badRuns })).toBe(503);
  });
});
