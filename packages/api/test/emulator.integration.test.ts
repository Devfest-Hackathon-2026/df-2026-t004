import { describe, expect, it } from "vitest";

describe("Firebase Emulator 接続設定", () => {
  it("FIRESTORE_EMULATOR_HOST が設定されている", () => {
    expect(process.env["FIRESTORE_EMULATOR_HOST"]).toBeTruthy();
  });
});
