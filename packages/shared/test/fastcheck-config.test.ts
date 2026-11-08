import fc from "fast-check";
import { describe, expect, it } from "vitest";

describe("fast-check の共通設定", () => {
  it("numRuns の既定値が 100 以上である", () => {
    expect(fc.readConfigureGlobal().numRuns).toBeGreaterThanOrEqual(100);
  });
});
