import { describe, expect, it } from "vitest";
import { MOCK_PROGRAMS } from "../src/mock/programs.js";
import { createMockDashboardApi, tasksFromProgram } from "../src/services/dashboardApi.js";
import { toMatchHousehold } from "../src/state/household.js";
import type { Household } from "../src/services/householdApi.js";

const household: Household = {
  postalCode: "1920083",
  municipalityCode: "13201",
  prefecture: "東京都",
  city: "八王子市",
  town: "旭町",
  children: [{ id: "c1", ageYears: 4, recordedAt: "2026-11-09" }],
  onboardingDeferred: [],
  sensitiveConsent: false,
  sensitive: null,
};

describe("ダッシュボードの仮実装（Requirement 4.1〜4.4, 4.8, 4.11）", () => {
  it("世帯の年齢区分で候補を選び、未確認の制度は出さない", async () => {
    const api = createMockDashboardApi();
    const d = await api.getDashboard(toMatchHousehold(household, "2026-11-09"), "2026-11-09", null);
    if (!d.programs.ok) throw new Error("programs failed");
    const ids = d.programs.data.map((m) => m.program.id);
    expect(ids).toContain("infant-medical");
    expect(ids).toContain("child-allowance"); // 年齢区分「不明」は要確認で含める
    expect(ids).not.toContain("unverified");
    expect(ids).not.toContain("teen-scholarship"); // 15〜18歳向け
    expect(ids).not.toContain("pregnancy-support"); // 同意が無いので妊娠中は導出しない
    expect(d.programs.data.find((m) => m.program.id === "tokyo-support")?.maybeClosed).toBe(true);
  });

  it("同意して出産予定日があれば、妊娠中向けの制度も候補になる", async () => {
    const h = {
      ...household,
      sensitiveConsent: true,
      sensitive: { situationChips: [], pregnancy: { dueDate: "2027-03-01" } },
    };
    const d = await createMockDashboardApi().getDashboard(
      toMatchHousehold(h, "2026-11-09"),
      "2026-11-09",
      "pregnancy",
    );
    expect(d.programs.ok && d.programs.data.map((m) => m.program.id)).toEqual([
      "pregnancy-support",
    ]);
  });

  it("申請を進行中にすると、進行中の申請に出る", async () => {
    const api = createMockDashboardApi();
    const p = MOCK_PROGRAMS[0]!;
    await api.updateApplication(p.id, { status: "in_progress", tasks: tasksFromProgram(p) });
    const d = await api.getDashboard(toMatchHousehold(household, "2026-11-09"), "2026-11-09", null);
    expect(
      d.applications.ok &&
        d.applications.data.map((a) => [a.programId, a.status, a.deadline, a.tasks.length]),
    ).toEqual([[p.id, "in_progress", "2026-11-30", 4]]);
  });

  it("未確認の制度の詳細は見つからない扱いにする", async () => {
    expect((await createMockDashboardApi().getProgram("unverified")).status).toBe("not-found");
    expect((await createMockDashboardApi().getProgram("infant-medical")).status).toBe("ok");
  });
});
