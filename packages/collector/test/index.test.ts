import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, SHARED_REFERENCE } from "../src/index.js";

describe("collector パッケージ", () => {
  it("パッケージ名を公開している", () => {
    expect(PACKAGE_NAME).toBe("@hachioji-gov/collector");
  });

  it("shared パッケージを参照できる", () => {
    expect(SHARED_REFERENCE).toBe("@hachioji-gov/shared");
  });
});
