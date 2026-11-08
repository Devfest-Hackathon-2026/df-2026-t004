import { describe, expect, it } from "vitest";
import { SHARED_PACKAGE } from "../src/index.js";

describe("shared パッケージ", () => {
  it("パッケージ名の定数を公開している", () => {
    expect(SHARED_PACKAGE).toBe("@hachioji-gov/shared");
  });
});
