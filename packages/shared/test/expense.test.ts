import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  aggregateExpenses,
  applyVerification,
  canSaveExpense,
  expenseDateMin,
  suggestProgramsFromExpenses,
  validateExpense,
  type ExpenseRecord,
  type Program,
} from "../src/index.js";

const isoDate = fc
  .date({
    min: new Date("2015-01-01T00:00:00Z"),
    max: new Date("2035-12-31T00:00:00Z"),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString().slice(0, 10));
const shiftDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const SUBJECTS = ["c1", "c2"];

// Feature: childcare-medical-welfare-navi, Property 31: 医療費記録の検証
// Validates: Requirements 6.1, 6.3, 6.4
describe("validateExpense / canSaveExpense (Property 31)", () => {
  const facility = fc
    .integer({ min: 0, max: 120 })
    .chain((n) =>
      fc.tuple(
        fc.constant(n),
        fc.string({ unit: fc.constantFrom("あ", "a", "1", "病"), minLength: n, maxLength: n }),
      ),
    );
  const amount = fc.oneof(
    fc.integer({ min: -10, max: 10_000_010 }),
    fc.double({ min: 0, max: 100, noNaN: true }),
  );
  const subject = fc.constantFrom("c1", "c2", "guardian", "c9", "");

  it("成功するのは、日付・医療機関名・金額・対象者がすべて範囲内のときに限り、失敗した欄ごとにエラーが返る", () => {
    fc.assert(
      fc.property(
        isoDate,
        fc.integer({ min: -2000, max: 30 }),
        facility,
        amount,
        subject,
        (today, k, [n, f], a, s) => {
          const date = shiftDays(today, k);
          const input = { date, facility: f, amountYen: a, subjectId: s };
          const r = validateExpense(input, today, SUBJECTS);
          // 保存ボタンを有効にする判定は、検証の結果と常に一致する
          expect(canSaveExpense(input, today, SUBJECTS)).toBe(r.ok);
          const dateOk = date <= today && date >= expenseDateMin(today)!;
          const facilityOk = n >= 1 && n <= 100;
          const amountOk = Number.isInteger(a) && a >= 1 && a <= 9_999_999;
          const subjectOk = ["c1", "c2", "guardian"].includes(s);
          expect(r.ok).toBe(dateOk && facilityOk && amountOk && subjectOk);
          const fields = r.errors.map((e) => e.field);
          expect(fields.includes("date")).toBe(!dateOk);
          expect(fields.includes("facility")).toBe(!facilityOk);
          expect(fields.includes("amountYen")).toBe(!amountOk);
          expect(fields.includes("subjectId")).toBe(!subjectOk);
        },
      ),
    );
  });

  it("5年前の同日は可、その前日は不可。フォームの文字列（YYYY/MM/DD・全角・カンマ）も受け付ける", () => {
    const today = "2026-11-09";
    const ok = { facility: "[医療機関]", amountYen: "１,２００", subjectId: "c1" };
    expect(validateExpense({ ...ok, date: "2021/11/09" }, today, SUBJECTS).ok).toBe(true);
    expect(validateExpense({ ...ok, date: "2021-11-08" }, today, SUBJECTS).ok).toBe(false);
    expect(validateExpense({ ...ok, date: "2026-11-10" }, today, SUBJECTS).ok).toBe(false);
    expect(
      validateExpense({ ...ok, date: "2026-11-09", amountYen: "" }, today, SUBJECTS).errors[0]
        ?.message,
    ).toContain("金額を入れて");
    expect(expenseDateMin("2028-02-29")).toBe("2023-02-28");
  });
});

const record: fc.Arbitrary<ExpenseRecord> = fc.record({
  id: fc.uuid(),
  date: isoDate,
  facility: fc.constant("[医療機関]"),
  amountYen: fc.integer({ min: 1, max: 9_999_999 }),
  subjectId: fc.constantFrom("c1", "c2", "guardian"),
  createdAt: fc.constant("2026-01-01T00:00:00Z"),
  updatedAt: fc.constant("2026-01-01T00:00:00Z"),
});

// Feature: childcare-medical-welfare-navi, Property 32: 医療費の集計
// Validates: Requirements 6.2
describe("aggregateExpenses (Property 32)", () => {
  const sum = (bs: readonly { totalYen: number }[]) => bs.reduce((s, b) => s + b.totalYen, 0);

  it("月別・年別・家族別の合計は、いずれも全記録の合計に等しい", () => {
    fc.assert(
      fc.property(fc.array(record, { maxLength: 40 }), (rs) => {
        const s = aggregateExpenses(rs);
        const total = rs.reduce((t, r) => t + r.amountYen, 0);
        expect(s.totalYen).toBe(total);
        expect(sum(s.byMonth)).toBe(total);
        expect(sum(s.byYear)).toBe(total);
        expect(sum(s.bySubject)).toBe(total);
        expect(s.byMonth.reduce((c, b) => c + b.count, 0)).toBe(rs.length);
      }),
    );
  });

  it("記録を追加してから削除すると、集計は元に戻る", () => {
    fc.assert(
      fc.property(fc.array(record, { maxLength: 30 }), record, (rs, extra) => {
        fc.pre(!rs.some((r) => r.id === extra.id));
        const after = [...rs, extra].filter((r) => r.id !== extra.id);
        expect(aggregateExpenses(after)).toEqual(aggregateExpenses(rs));
      }),
    );
  });
});

// Feature: childcare-medical-welfare-navi, Property 33: 医療費からの制度の提示
// Validates: Requirements 6.5
describe("suggestProgramsFromExpenses (Property 33)", () => {
  const program: fc.Arbitrary<Program> = fc
    .record({
      id: fc.stringMatching(/^p[0-9]{1,3}$/),
      category: fc.constantFrom("medical" as const, "childcare" as const),
      verified: fc.boolean(),
      needsReview: fc.boolean(),
      sourceUrl: fc.option(fc.constant("https://example.com/p"), { nil: null }),
      fetchedAt: fc.option(fc.constant("2026-10-01"), { nil: null }),
      requiredDocs: fc.option(fc.subarray(["領収書", "申請書", "保険証の写し"]), { nil: null }),
    })
    .map((r) => ({
      ...r,
      sourceId: "s",
      name: `[${r.id}]`,
      level: "city" as const,
      municipalityCode: "13201",
      ageBands: ["unknown" as const],
      summary: null,
      eligibility: null,
      procedure: null,
      deadline: null,
      contact: null,
      sourceName: "[出典]",
      contentHash: "h",
      status: "active" as const,
      updatedAt: "2026-10-01",
    }));

  it("確認済みの制度だけを最大5件返し、各件に出典URLと取得日を含める", () => {
    fc.assert(
      fc.property(
        fc.array(record, { maxLength: 20 }),
        fc.uniqueArray(program, { maxLength: 15, selector: (p) => p.id }),
        (rs, ps) => {
          const today = "2026-11-09";
          const out = suggestProgramsFromExpenses(rs, ps, { today });
          expect(out.length).toBeLessThanOrEqual(5);
          for (const s of out) {
            const p = ps.find((x) => x.id === s.programId)!;
            expect(p.verified && !p.needsReview).toBe(true);
            expect(s.source.url.length).toBeGreaterThan(0);
            expect(s.source.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(s.label).toBe("対象の可能性");
            expect(
              s.recordIds.every((id) => rs.some((r) => r.id === id && r.date.startsWith("2026"))),
            ).toBe(true);
          }
        },
      ),
    );
  });

  it("そろえた書類は「不足している書類」から外れる。記録が無ければ何も提示しない", () => {
    const base = fc.sample(program, 1)[0]!;
    const p = applyVerification(
      {
        ...base,
        id: "p1",
        category: "medical",
        sourceUrl: "https://example.com",
        fetchedAt: "2026-10-01",
        requiredDocs: ["領収書", "申請書"],
      },
      "h",
      "2026-10-02",
    );
    const r: ExpenseRecord = {
      id: "e1",
      date: "2026-11-01",
      facility: "x",
      amountYen: 1200,
      subjectId: "c1",
      createdAt: "",
      updatedAt: "",
    };
    const [s] = suggestProgramsFromExpenses([r], [p], {
      today: "2026-11-09",
      preparedDocs: { p1: ["領収書"] },
    });
    expect(s?.missingDocs).toEqual(["申請書"]);
    expect(s?.periodTotalYen).toBe(1200);
    expect(suggestProgramsFromExpenses([], [p], { today: "2026-11-09" })).toEqual([]);
  });
});
