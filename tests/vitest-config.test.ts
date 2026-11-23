import { describe, expect, it } from "vitest";
import config from "../vitest.config";

describe("the Vitest config", () => {
  it("runs test files one at a time, because they share one database", () => {
    expect(config.test?.fileParallelism).toBe(false);
  });
});
