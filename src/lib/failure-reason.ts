/**
 * The database answered, but not with the shape the chart route expects. It gets its own name and
 * code so that a malformed row and a bug in the code do not both log `name=TypeError code=none`.
 * The message never holds a value from the row.
 */
export class ChartShapeError extends Error {
  readonly code = "CHART_SHAPE";

  constructor() {
    super("The database returned a chart in a shape the site does not expect.");
    this.name = "ChartShapeError";
  }
}

/**
 * Turns any thrown value into a short reason that is safe to log.
 * It keeps the error name and one code, and nothing else. The message is
 * never read, because a message can hold a key, an address or a query.
 */
const SAFE_TOKEN = /^[A-Za-z0-9_]{1,40}$/;

function safe(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_TOKEN.test(value) ? value : undefined;
}

export function failureReason(error: unknown): string {
  const record = (typeof error === "object" && error !== null ? error : {}) as {
    name?: unknown;
    code?: unknown;
    cause?: { code?: unknown } | null;
  };
  const name = safe(record.name) ?? "UnknownError";
  const code = safe(record.cause?.code) ?? safe(record.code) ?? "none";
  return `name=${name} code=${code}`;
}
