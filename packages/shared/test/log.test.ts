import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createLogger, LOG_ALLOWED_KEYS, redactForLog } from "../src/index.js";

// --- 生成器: ログに出してはいけない値 -------------------------------------

const japaneseChar = fc.constantFrom(
  ..."あいうえおかきくけこ子育て医療費助成児童手当妊娠出産保育園申請",
);
const question = fc
  .array(japaneseChar, { minLength: 1, maxLength: 30 })
  .map((cs) => `質問${cs.join("")}`);
const email = fc.emailAddress();
const phone = fc
  .tuple(
    fc.constantFrom("090", "080", "070", "042"),
    fc.integer({ min: 0, max: 9999 }),
    fc.integer({ min: 0, max: 9999 }),
    fc.boolean(),
  )
  .map(([a, b, c, hyphen]) => {
    const parts = [a, String(b).padStart(4, "0"), String(c).padStart(4, "0")];
    return hyphen ? parts.join("-") : parts.join("");
  });
const postalCode = fc
  .tuple(fc.integer({ min: 100, max: 999 }), fc.integer({ min: 0, max: 9999 }))
  .map(([a, b]) => `${a}-${String(b).padStart(4, "0")}`);
const llmText = fc.string({ minLength: 1, maxLength: 40 }).map((s) => `LLM出力:${s}`);

const sensitive = fc.oneof(question, email, phone, postalCode, llmText);

// 許可リストの項目の、正しい形式の値
const allowedValues = fc.record(
  {
    requestId: fc.uuid(),
    status: fc.integer({ min: 100, max: 599 }),
    durationMs: fc.integer({ min: 0, max: 600_000 }),
    count: fc.integer({ min: 0, max: 1000 }),
  },
  { requiredKeys: [] },
);

/** 秘匿値を、許可リスト外のキー・入れ子・例外メッセージ・許可リストのキーに混ぜたコンテキスト */
const context = fc
  .tuple(
    allowedValues,
    fc.array(sensitive, { minLength: 1, maxLength: 6 }),
    fc.constantFrom(...LOG_ALLOWED_KEYS),
    fc.constantFrom("Error", "TypeError", "ValidationError"),
  )
  .map(([allowed, secrets, hijackedKey, errorName]) => {
    const [first, ...rest] = secrets as [string, ...string[]];
    const error = new Error(`入力 ${first} の処理に失敗`);
    error.name = errorName;
    const ctx: Record<string, unknown> = {
      ...allowed,
      question: first,
      household: { email: rest[0] ?? first, children: [{ note: rest[1] ?? first }] },
      llm: { input: rest[2] ?? first, output: rest[3] ?? first },
      error,
    };
    // 許可リストのキーにも秘匿値を入れてみる（形式の検査で落ちるべき）
    Object.assign(ctx, { [hijackedKey]: rest[4] ?? first });
    return { ctx, secrets };
  });

// Feature: childcare-medical-welfare-navi, Property 49: ログの許可リスト
// Validates: Requirements 15.3
describe("redactForLog (Property 49)", () => {
  it("出力のキーは許可リストの部分集合で、秘匿値はどこにも現れない", () => {
    fc.assert(
      fc.property(context, ({ ctx, secrets }) => {
        const out = redactForLog(ctx);
        for (const key of Object.keys(out)) {
          expect(LOG_ALLOWED_KEYS).toContain(key);
        }
        const serialized = JSON.stringify(out);
        for (const secret of secrets) {
          expect(serialized).not.toContain(secret);
        }
      }),
    );
  });

  it("任意のキーと値でも、出力のキーは許可リストの部分集合", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.anything()), (ctx) => {
        for (const key of Object.keys(redactForLog(ctx))) {
          expect(LOG_ALLOWED_KEYS).toContain(key);
        }
      }),
    );
  });

  it("正しい形式の許可項目はそのまま残る", () => {
    fc.assert(
      fc.property(allowedValues, (allowed) => {
        expect(redactForLog(allowed)).toEqual(allowed);
      }),
    );
  });
});

describe("redactForLog の個別の規則", () => {
  it("例外は名前だけを errorType にし、メッセージは出さない", () => {
    const err = new TypeError("メール test-user@example.com が不正");
    expect(redactForLog({ error: err })).toEqual({ errorType: "TypeError" });
  });

  it("識別子でないエラー種別は UnknownError にする", () => {
    expect(redactForLog({ errorType: "八王子市の児童手当" })).toEqual({
      errorType: "UnknownError",
    });
    expect(redactForLog({ error: "文字列の例外" })).toEqual({ errorType: "UnknownError" });
  });

  it("形式の合わない許可項目は捨てる", () => {
    expect(
      redactForLog({
        requestId: "09000000000",
        status: 42,
        durationMs: -1,
        count: 1.5,
      }),
    ).toEqual({});
  });

  it("32桁の16進数のトレースIDは受け付ける", () => {
    const traceId = "105445aa7843bc8bf206b12000100000";
    expect(redactForLog({ requestId: traceId })).toEqual({ requestId: traceId });
  });
});

describe("createLogger", () => {
  const fixedNow = () => new Date("2026-04-01T00:00:00.000Z");

  it("JSON 1行で、許可項目だけを出す", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (line) => lines.push(line), now: fixedNow });
    logger.info("chat.completed", { status: 200, question: "保育園の申請は？", count: 3 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      severity: "INFO",
      message: "chat.completed",
      time: "2026-04-01T00:00:00.000Z",
      status: 200,
      count: 3,
    });
  });

  it("イベント名に任意の文字列を入れても出力されない", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (line) => lines.push(line), now: fixedNow });
    logger.error("保育園の申請は？", { error: new Error("x") });
    expect(lines[0]).not.toContain("保育園");
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      severity: "ERROR",
      message: "invalid_event",
      errorType: "Error",
    });
  });

  it("重大度を sink に渡す", () => {
    const severities: string[] = [];
    const logger = createLogger({ sink: (_line, s) => severities.push(s), now: fixedNow });
    logger.debug("a");
    logger.info("a");
    logger.warn("a");
    logger.error("a");
    expect(severities).toEqual(["DEBUG", "INFO", "WARNING", "ERROR"]);
  });
});
