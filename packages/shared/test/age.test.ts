import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AGE_BANDS,
  ageToBand,
  deriveAgeBands,
  estimateAge,
  type StoredChild,
} from "../src/index.js";

const isoDate = fc
  .date({
    min: new Date("2010-01-01T00:00:00Z"),
    max: new Date("2040-12-31T00:00:00Z"),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString().slice(0, 10));
const shiftDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const child: fc.Arbitrary<StoredChild> = fc
  .tuple(fc.integer({ min: 0, max: 18 }), fc.integer({ min: 0, max: 11 }), isoDate)
  .map(([ageYears, m, recordedAt]) =>
    ageYears === 0
      ? { id: "c", ageYears, ageMonths: m, recordedAt }
      : { id: "c", ageYears, recordedAt },
  );

// Feature: childcare-medical-welfare-navi, Property 8: 推定年齢と年齢区分の変換
// Validates: Requirements 2.9, 3.4, 4.2
describe("estimateAge / ageToBand (Property 8)", () => {
  const total = (a: { years: number; months: number }) => a.years * 12 + a.months;

  it("現在日が進んでも推定年齢は減少しない", () => {
    fc.assert(
      fc.property(
        child,
        fc.integer({ min: 0, max: 4000 }),
        fc.integer({ min: 0, max: 400 }),
        (c, a, b) => {
          const t1 = shiftDays(c.recordedAt, a);
          const t2 = shiftDays(t1, b);
          expect(total(estimateAge(c, t2))).toBeGreaterThanOrEqual(total(estimateAge(c, t1)));
        },
      ),
    );
  });

  it("記録日の時点では入力した年齢、1年後には1歳増える", () => {
    fc.assert(
      fc.property(child, (c) => {
        const now = estimateAge(c, c.recordedAt);
        expect(now.years).toBe(c.ageYears);
        const [y, m, d] = c.recordedAt.split("-");
        const nextYear = `${Number(y) + 1}-${m}-${d === "29" && m === "02" ? "28" : d}`;
        const later = estimateAge(c, nextYear);
        // 2/29 生まれの記録は翌年 2/28 ではまだ満了しない
        if (!(m === "02" && d === "29")) expect(later.years).toBe(c.ageYears + 1);
      }),
    );
  });

  it("0〜18歳は妊娠中を除く1区分、19歳以上と負の値は null", () => {
    fc.assert(
      fc.property(fc.integer({ min: -5, max: 40 }), (age) => {
        const band = ageToBand(age);
        if (age < 0 || age > 18) expect(band).toBeNull();
        else expect(AGE_BANDS.filter((b) => b !== "pregnancy")).toContain(band);
      }),
    );
  });

  it("境界は 2|3、5|6、11|12、14|15 で切り替わる", () => {
    const pairs: Array<[number, number]> = [
      [2, 3],
      [5, 6],
      [11, 12],
      [14, 15],
    ];
    for (const [a, b] of pairs) expect(ageToBand(a)).not.toBe(ageToBand(b));
    expect([0, 1, 2].map(ageToBand)).toEqual(["age_0_2", "age_0_2", "age_0_2"]);
    expect([3, 5, 6, 11, 12, 14, 15, 18].map(ageToBand)).toEqual([
      "age_3_5",
      "age_3_5",
      "age_6_11",
      "age_6_11",
      "age_12_14",
      "age_12_14",
      "age_15_18",
      "age_15_18",
    ]);
    expect(ageToBand(19)).toBeNull();
    expect(ageToBand(2.5)).toBeNull();
  });
});

// Feature: childcare-medical-welfare-navi, Property 9: 世帯の年齢区分の導出
// Validates: Requirements 2.7, 2.14, 9.3
describe("deriveAgeBands (Property 9)", () => {
  const pregnancy = fc.option(fc.integer({ min: -60, max: 300 }), { nil: null });

  it("pregnancy を含むのは、同意があり有効な出産予定日があるときに限る", () => {
    fc.assert(
      fc.property(
        fc.array(child, { maxLength: 4 }),
        pregnancy,
        fc.boolean(),
        isoDate,
        (kids, k, consent, today) => {
          const p = k === null ? null : { dueDate: shiftDays(today, k) };
          const r = deriveAgeBands(kids, p, consent, today);
          expect(r.bands.includes("pregnancy")).toBe(consent && k !== null && k >= 0);
        },
      ),
    );
  });

  it("結果が空のときに限り unset、区分は重複せず定義順に並ぶ", () => {
    fc.assert(
      fc.property(
        fc.array(child, { maxLength: 6 }),
        pregnancy,
        fc.boolean(),
        isoDate,
        (kids, k, consent, today) => {
          const r = deriveAgeBands(
            kids,
            k === null ? null : { dueDate: shiftDays(today, k) },
            consent,
            today,
          );
          expect(r.unset).toBe(r.bands.length === 0);
          expect(new Set(r.bands).size).toBe(r.bands.length);
          expect([...r.bands]).toEqual(AGE_BANDS.filter((b) => r.bands.includes(b)));
        },
      ),
    );
  });

  it("同意を撤回した入力（consent=false）では pregnancy が含まれない", () => {
    fc.assert(
      fc.property(
        fc.array(child, { maxLength: 4 }),
        isoDate,
        fc.integer({ min: 0, max: 300 }),
        (kids, today, k) => {
          expect(
            deriveAgeBands(kids, { dueDate: shiftDays(today, k) }, false, today).bands,
          ).not.toContain("pregnancy");
        },
      ),
    );
  });

  it("子ども0人で出産予定日の同意を拒否すると unset になる（Requirement 2.7）", () => {
    expect(deriveAgeBands([], { dueDate: "2027-01-01" }, false, "2026-11-09")).toEqual({
      bands: [],
      unset: true,
    });
    expect(deriveAgeBands([], { dueDate: "2027-01-01" }, true, "2026-11-09")).toEqual({
      bands: ["pregnancy"],
      unset: false,
    });
  });
});
