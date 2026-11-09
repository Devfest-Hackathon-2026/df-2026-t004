import { describe, expect, it } from "vitest";
import { draftFromHousehold } from "../src/screens/HouseholdEdit.js";
import { createMockHouseholdApi } from "../src/services/householdApi.js";

describe("世帯情報の編集（Requirement 8.1, 11.8）", () => {
  it("保存済みの世帯情報をフォームの値に戻せる（あとで入力するも保つ）", async () => {
    const api = createMockHouseholdApi();
    const r = await api.saveHousehold(
      {
        postalCode: "1920083",
        children: [{ ageYears: 4 }, { ageYears: 0, ageMonths: 3 }],
        dueDate: "2027-01-10",
        sensitiveConsent: true,
        onboardingDeferred: ["situationChips"],
      },
      "2026-11-09",
    );
    if (!r.ok) throw new Error("save failed");
    const d = draftFromHousehold(r.household);
    expect(d.children).toEqual([
      { mode: "years", value: "4" },
      { mode: "months", value: "3" },
    ]);
    expect(d.dueDate).toBe("2027-01-10");
    expect(d.deferred).toEqual(["situationChips"]);
    expect(d.sensitiveConsent).toBe(true);
  });
});
