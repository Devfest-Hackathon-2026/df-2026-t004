import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyConsentWithdrawal,
  canReadSensitive,
  readSensitive,
  splitByConsent,
  type HouseholdInput,
  type SensitiveState,
} from "../src/index.js";

const householdInput: fc.Arbitrary<HouseholdInput> = fc.record(
  {
    postalCode: fc.stringMatching(/^\d{7}$/),
    children: fc.array(
      fc.record(
        { ageYears: fc.integer({ min: 0, max: 18 }), ageMonths: fc.integer({ min: 0, max: 11 }) },
        { requiredKeys: ["ageYears"] },
      ),
      { maxLength: 5 },
    ),
    dueDate: fc.constantFrom("2026-12-01", "2027-03-15"),
    situationChips: fc.array(fc.constantFrom("disability", "sports", "study_abroad"), {
      maxLength: 3,
    }),
    freeText: fc.string({ minLength: 1, maxLength: 200 }),
  },
  { requiredKeys: ["postalCode", "children"] },
);

// Feature: childcare-medical-welfare-navi, Property 6: 同意による要配慮情報の分離
// Validates: Requirements 2.6, 2.7, 9.1, 9.2
describe("splitByConsent (Property 6)", () => {
  it("同意がなければ、要配慮情報は保存ペイロードのどこにも入らない", () => {
    fc.assert(
      fc.property(householdInput, (input) => {
        const split = splitByConsent(input, false);
        expect(split.sensitive).toBeNull();
        const json = JSON.stringify(split);
        expect(json).not.toContain("dueDate");
        expect(json).not.toContain("situationChips");
        expect(json).not.toContain("childNote");
        // 要配慮でない項目（郵便番号・子ども）だけが残る
        expect(Object.keys(split.household).sort()).toEqual(["children", "postalCode"]);
      }),
    );
  });

  it("同意があれば、要配慮情報は失われずに sensitive 側へ入る", () => {
    fc.assert(
      fc.property(householdInput, (input) => {
        const s = splitByConsent(input, true).sensitive!;
        expect(s.situationChips).toEqual(input.situationChips ?? []);
        expect(s.childNote).toBe(input.freeText);
        expect(s.pregnancy?.dueDate).toBe(input.dueDate);
      }),
    );
  });

  it("要配慮でない項目は、同意の有無で変わらない", () => {
    fc.assert(
      fc.property(householdInput, (input) => {
        expect(splitByConsent(input, true).household).toEqual(
          splitByConsent(input, false).household,
        );
        expect(splitByConsent(input, false).household.postalCode).toBe(input.postalCode);
        expect(splitByConsent(input, false).household.children).toEqual(input.children);
      }),
    );
  });
});

// Feature: childcare-medical-welfare-navi, Property 50: 同意撤回後の要配慮情報
// Validates: Requirements 9.3, 9.4
describe("applyConsentWithdrawal / canReadSensitive (Property 50)", () => {
  const state: fc.Arbitrary<SensitiveState> = fc.record({
    consent: fc.boolean(),
    sensitive: fc.option(
      fc.record({
        situationChips: fc.array(fc.string(), { maxLength: 3 }),
        pregnancy: fc.record({ dueDate: fc.constant("2027-01-01") }),
      }),
      { nil: null },
    ),
    sensitiveLocked: fc.boolean(),
  });
  const outcome = fc.constantFrom("succeeded" as const, "failed" as const);

  it("撤回の後は要配慮情報が空になり、読み出せない", () => {
    fc.assert(
      fc.property(state, outcome, (s, o) => {
        const after = applyConsentWithdrawal(s, o);
        expect(after.sensitive).toBeNull();
        expect(after.consent).toBe(false);
        expect(canReadSensitive(after)).toBe(false);
        expect(readSensitive(after)).toBeNull();
      }),
    );
  });

  it("削除に失敗した状態はロックされ、再試行で成功するまでロックが続く", () => {
    fc.assert(
      fc.property(state, fc.array(outcome, { maxLength: 5 }), (s, retries) => {
        let cur = applyConsentWithdrawal(s, "failed");
        expect(cur.sensitiveLocked).toBe(true);
        for (const o of retries) {
          cur = applyConsentWithdrawal(cur, o);
          expect(cur.sensitiveLocked).toBe(o === "failed");
          expect(canReadSensitive(cur)).toBe(false);
        }
      }),
    );
  });

  it("読み出せるのは、同意がありロックされていないときに限る", () => {
    fc.assert(
      fc.property(state, (s) => {
        expect(canReadSensitive(s)).toBe(s.consent && !s.sensitiveLocked);
      }),
    );
  });
});
