// 制度と医療費の変換（Property 51: シリアライズのラウンドトリップ）
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AMOUNT_MAX,
  decodeExpenseRecord,
  decodeProgram,
  encodeExpenseRecord,
  encodeProgram,
  PROGRAM_CATEGORIES,
  SOURCE_AGE_BANDS,
  type ExpenseRecord,
  type Program,
} from "../src/index.js";

const nonBlank = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim() !== "");
const docId = fc.stringMatching(/^[A-Za-z0-9_-]{1,20}$/);
const isoDateTime = fc
  .integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2030, 0, 1) })
  .map((t) => new Date(t).toISOString());
const isoDate = isoDateTime.map((s) => s.slice(0, 10));
const nullable = <T>(a: fc.Arbitrary<T>) => fc.option(a, { nil: null });

const program: fc.Arbitrary<Program> = fc.record(
  {
    id: docId,
    sourceId: nonBlank,
    name: nonBlank,
    level: fc.constantFrom("national" as const, "tokyo" as const, "city" as const),
    municipalityCode: fc.constantFrom("00000", "13000", "13201"),
    category: fc.constantFrom(...PROGRAM_CATEGORIES),
    ageBands: fc.uniqueArray(fc.constantFrom(...SOURCE_AGE_BANDS), { maxLength: 7 }),
    summary: nullable(fc.string({ maxLength: 40 })),
    eligibility: nullable(fc.string({ maxLength: 40 })),
    procedure: nullable(fc.string({ maxLength: 40 })),
    requiredDocs: nullable(fc.array(nonBlank, { maxLength: 4 })),
    deadline: nullable(isoDate),
    contact: nullable(
      fc.record(
        { name: nonBlank, phone: fc.constant("090-0000-0000"), url: fc.webUrl() },
        { requiredKeys: ["name"] },
      ),
    ),
    sourceName: nullable(nonBlank),
    sourceUrl: nullable(fc.webUrl()),
    fetchedAt: nullable(isoDateTime),
    verified: fc.boolean(),
    verifiedAt: isoDate,
    verifiedBy: nonBlank,
    verifiedContentHash: fc.stringMatching(/^[0-9a-f]{64}$/),
    contentHash: fc.stringMatching(/^[0-9a-f]{64}$/),
    needsReview: fc.boolean(),
    status: fc.constantFrom("active" as const, "excluded" as const),
    updatedAt: isoDateTime,
  },
  {
    requiredKeys: [
      "id",
      "sourceId",
      "name",
      "level",
      "municipalityCode",
      "category",
      "ageBands",
      "summary",
      "eligibility",
      "procedure",
      "requiredDocs",
      "deadline",
      "contact",
      "sourceName",
      "sourceUrl",
      "fetchedAt",
      "verified",
      "contentHash",
      "needsReview",
      "status",
      "updatedAt",
    ],
  },
);

const expense: fc.Arbitrary<ExpenseRecord> = fc.record({
  id: docId,
  date: isoDate,
  facility: fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim() !== ""),
  amountYen: fc.integer({ min: 1, max: AMOUNT_MAX }),
  subjectId: fc.constantFrom("c1", "c2", "guardian"),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

describe("Program の変換", () => {
  it("encode して decode すると元に戻る", () => {
    fc.assert(
      fc.property(program, (p) => {
        expect(decodeProgram(p.id, encodeProgram(p))).toEqual({ ok: true, value: p });
      }),
    );
  });

  it("保存する本文に id と値の無い任意項目を入れない", () => {
    fc.assert(
      fc.property(program, (p) => {
        const data = encodeProgram(p);
        expect(data).not.toHaveProperty("id");
        for (const value of Object.values(data)) expect(value).not.toBeUndefined();
      }),
    );
  });

  it("形が違う値は拒否する", () => {
    expect(decodeProgram("p1", null).ok).toBe(false);
    expect(decodeProgram("p1", { name: "児童手当" }).ok).toBe(false);
    fc.assert(
      fc.property(program, (p) => {
        const data = encodeProgram(p);
        expect(decodeProgram(p.id, { ...data, category: "other" }).ok).toBe(false);
        expect(decodeProgram(p.id, { ...data, deadline: "2026-02-30" }).ok).toBe(false);
        expect(decodeProgram("../x", data).ok).toBe(false);
      }),
    );
  });
});

describe("ExpenseRecord の変換", () => {
  it("encode して decode すると元に戻る", () => {
    fc.assert(
      fc.property(expense, (e) => {
        const data = encodeExpenseRecord(e);
        expect(data).not.toHaveProperty("id");
        expect(decodeExpenseRecord(e.id, data)).toEqual({ ok: true, value: e });
      }),
    );
  });

  it("金額・日付・医療機関名が範囲外なら拒否する", () => {
    fc.assert(
      fc.property(expense, (e) => {
        const data = encodeExpenseRecord(e);
        expect(decodeExpenseRecord(e.id, { ...data, amountYen: 0 }).ok).toBe(false);
        expect(decodeExpenseRecord(e.id, { ...data, amountYen: 1.5 }).ok).toBe(false);
        expect(decodeExpenseRecord(e.id, { ...data, date: "2026/11/09" }).ok).toBe(false);
        expect(decodeExpenseRecord(e.id, { ...data, facility: "あ".repeat(101) }).ok).toBe(false);
      }),
    );
  });
});
