import { describe, expect, it } from "vitest";
import { createLogger, scanLogForLeaks, type LeakKind } from "../src/index.js";

function kinds(text: string, canaries?: string[]): LeakKind[] {
  return scanLogForLeaks(text, { canaries }).map((f) => f.kind);
}

describe("scanLogForLeaks: 検出する", () => {
  it.each<[string, string, LeakKind]>([
    ["メール", "user test-user+tag@example.com logged in", "email"],
    ["携帯（ハイフンあり）", "tel: 090-0000-0000", "phone"],
    ["携帯（ハイフンなし）", "tel=09000000000", "phone"],
    ["固定電話", "042-000-0000", "phone"],
    ["郵便番号", "〒192-0001 八王子市", "postalCode"],
    ["郵便番号（記号なし）", "zip 192-0001", "postalCode"],
    ["Google API キー", `key=AIza${"A".repeat(35)}`, "googleApiKey"],
    ["秘密鍵", `${"-".repeat(5)}BEGIN PRIVATE KEY${"-".repeat(5)}`, "privateKey"],
    ["JWT", `token ${["eyJhbGciOiJub25lIn0", "eyJzdWIiOiJkdW1teSJ9", "c2ln"].join(".")}`, "jwt"],
    ["Bearer トークン", `Authorization: Bearer ${"a".repeat(30)}`, "bearerToken"],
    ["GitHub トークン", `ghp_${"a".repeat(36)}`, "githubToken"],
    ["Google OAuth トークン", `ya29.${"a".repeat(30)}`, "googleOAuthToken"],
  ])("%s", (_name, text, kind) => {
    expect(kinds(text)).toContain(kind);
  });

  it("カナリア文字列を検出する", () => {
    expect(kinds("received: カナリア質問XYZ", ["カナリア質問XYZ"])).toEqual(["canary"]);
  });

  it("行番号を返し、内容は返さない", () => {
    const findings = scanLogForLeaks("ok\nmail a@example.com\nok");
    expect(findings).toEqual([{ kind: "email", line: 2 }]);
  });
});

describe("scanLogForLeaks: 誤検出しない", () => {
  it.each([
    ["ISO 8601 の時刻", '{"time":"2026-04-01T00:00:00.000Z"}'],
    ["UUID", '{"requestId":"123e4567-e89b-12d3-a456-426614174000"}'],
    ["所要時間・件数", '{"durationMs":1234567,"count":42,"status":200}'],
    ["トレースID", '{"requestId":"105445aa7843bc8bf206b12000100000"}'],
    ["Emulator のアドレス", "Firestore Emulator: 127.0.0.1:8080"],
    ["空のカナリア", "anything"],
  ])("%s", (_name, text) => {
    expect(kinds(text, [""])).toEqual([]);
  });

  it("ロガーの出力（許可リストの項目だけ）は検出されない", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (line) => lines.push(line) });
    logger.info("request.completed", {
      requestId: "123e4567-e89b-12d3-a456-426614174000",
      status: 200,
      durationMs: 12.3,
      count: 5,
      question: "カナリア質問XYZ 090-0000-0000 test-user@example.com",
    });
    logger.error("request.failed", { error: new Error("〒192-0001 test-user@example.com") });
    expect(scanLogForLeaks(lines.join("\n"), { canaries: ["カナリア質問XYZ"] })).toEqual([]);
  });
});
