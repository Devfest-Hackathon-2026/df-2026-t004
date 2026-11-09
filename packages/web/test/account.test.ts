import { describe, expect, it } from "vitest";
import { createMockAccountApi } from "../src/services/accountApi.js";

const household = {
  municipalityCode: "13201",
  ageBands: { bands: ["age_3_5" as const], unset: false },
};
const today = "2026-11-09";
const subjects = ["c1", "guardian"];

describe("医療費の仮実装（Requirement 6.1〜6.5）", () => {
  it("不正な入力は保存せず、欄ごとのエラーを返す", async () => {
    const api = createMockAccountApi();
    const r = await api.saveExpense(
      { date: "", facility: "", amountYen: "", subjectId: "x" },
      today,
      subjects,
    );
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors.map((e) => e.field)).toEqual(["date", "facility", "amountYen", "subjectId"]);
    expect((await api.getExpenses(household, today)).records).toEqual([]);
  });

  it("保存・修正・削除が集計に反映され、医療費の制度を出典つきで提示する", async () => {
    const api = createMockAccountApi();
    const a = await api.saveExpense(
      { date: "2026/11/01", facility: "[医療機関A]", amountYen: "1,200", subjectId: "c1" },
      today,
      subjects,
    );
    const b = await api.saveExpense(
      { date: "2026-10-20", facility: "[医療機関B]", amountYen: 800, subjectId: "guardian" },
      today,
      subjects,
    );
    if (!a.ok || !b.ok) throw new Error("save failed");
    let o = await api.getExpenses(household, today);
    expect(o.summary.totalYen).toBe(2000);
    expect(o.summary.byMonth.map((x) => x.key)).toEqual(["2026-11", "2026-10"]);
    expect(o.suggestions.map((s) => s.programId)).toEqual(["infant-medical"]);
    expect(o.suggestions[0]?.source.fetchedAt).toBe("2026-10-01");

    await api.saveExpense(
      { date: "2026-11-01", facility: "[医療機関A]", amountYen: 1500, subjectId: "c1" },
      today,
      subjects,
      a.record.id,
    );
    o = await api.getExpenses(household, today);
    expect(o.summary.totalYen).toBe(2300);
    expect(o.records.find((r) => r.id === a.record.id)?.createdAt).toBe(a.record.createdAt);

    await api.deleteExpense(b.record.id);
    o = await api.getExpenses(household, today);
    expect(o.summary.totalYen).toBe(1500);
    expect(o.records.length).toBe(1);
  });
});
