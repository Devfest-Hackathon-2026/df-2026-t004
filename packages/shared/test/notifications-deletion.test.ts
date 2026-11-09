import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyDeletionPlan,
  cancelFor,
  deletionResult,
  notificationTimes,
  planAccountDeletion,
  planNotifications,
  type QueuedNotification,
} from "../src/index.js";

const isoDate = fc
  .date({
    min: new Date("2020-01-10T00:00:00Z"),
    max: new Date("2035-12-31T00:00:00Z"),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString().slice(0, 10));
const shiftDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// Feature: childcare-medical-welfare-navi, Property 34: 通知の計画と取消
// Validates: Requirements 7.1, 7.6
describe("notificationTimes / cancelFor (Property 34)", () => {
  it("締切の7日前と1日前の2つ（日本時間9時）を返す", () => {
    fc.assert(
      fc.property(isoDate, (deadline) => {
        const ts = notificationTimes(deadline);
        expect(ts.map((t) => t.kind)).toEqual(["deadline_7d", "deadline_1d"]);
        expect(ts.map((t) => t.date)).toEqual([shiftDays(deadline, -7), shiftDays(deadline, -1)]);
        for (const t of ts) expect(t.at).toBe(`${t.date}T00:00:00.000Z`);
      }),
    );
    expect(notificationTimes("2026-02-30")).toEqual([]);
  });

  it("取り消すと、その申請の通知は無くなり、他の申請の通知は変わらない", () => {
    const queue = fc
      .array(fc.tuple(fc.constantFrom("p1", "p2", "p3", "p4"), isoDate), { maxLength: 8 })
      .map((xs) => xs.flatMap(([id, d]) => planNotifications(id, `[${id}]`, d)));
    fc.assert(
      fc.property(queue, fc.constantFrom("p1", "p2", "p3", "p4"), (q: QueuedNotification[], id) => {
        const after = cancelFor(q, id);
        expect(after.some((n) => n.programId === id)).toBe(false);
        expect(after).toEqual(q.filter((n) => n.programId !== id));
        expect(
          planNotifications(id, "x", "2026-12-01").every(
            (n) => n.programName === "x" && n.deadline === "2026-12-01",
          ),
        ).toBe(true);
      }),
    );
  });
});

// Feature: childcare-medical-welfare-navi, Property 47: アカウント削除の分離性と冪等性
// Validates: Requirements 8.3, 8.5
describe("planAccountDeletion (Property 47)", () => {
  const uid = fc.stringMatching(/^[A-Za-z0-9_]{1,12}$/);
  const pathFor = (u: string) =>
    fc.oneof(
      fc.constant(`users/${u}`),
      fc
        .constantFrom("sensitive/profile", "expenses/e1", "chats/c1", "applications/p1")
        .map((s) => `users/${u}/${s}`),
      isoDate.map((d) => `usageUsers/${d}_${u}`),
      fc.constant(`deletionJobs/${u}`),
    );
  const others = fc.constantFrom(
    "programs/p1",
    "chunks/c1",
    "config/operations",
    "usage/2026-11-09",
  );

  it("対象は users/{uid} 配下と、その uid の利用回数ドキュメントだけで、他のユーザーのパスを含まない", () => {
    fc.assert(
      fc.property(uid, fc.array(uid, { maxLength: 4 }), (me, rest) => {
        const all = [
          ...fc.sample(fc.array(pathFor(me), { maxLength: 6 }), 1)[0]!,
          ...rest
            .filter((u) => u !== me)
            .flatMap((u) => fc.sample(fc.array(pathFor(u), { maxLength: 4 }), 1)[0]!),
          ...fc.sample(fc.array(others, { maxLength: 3 }), 1)[0]!,
        ];
        const plan = planAccountDeletion(me, all);
        for (const p of plan) {
          const mine =
            p === `users/${me}` ||
            p.startsWith(`users/${me}/`) ||
            (p.startsWith("usageUsers/") && p.slice("usageUsers/YYYY-MM-DD_".length) === me);
          expect(mine).toBe(true);
        }
        // 他のユーザーのパスと共有データは残る
        const left = applyDeletionPlan(all, plan);
        for (const p of all) if (!plan.includes(p)) expect(left).toContain(p);
      }),
    );
  });

  it("uid が後ろに一致するだけの他人の利用回数ドキュメントは含めない", () => {
    expect(
      planAccountDeletion("abc", [
        "usageUsers/2026-11-09_abc",
        "usageUsers/2026-11-09_x_abc",
        "users/abcd",
        "users/abc/expenses/e1",
      ]),
    ).toEqual(["usageUsers/2026-11-09_abc", "users/abc/expenses/e1"]);
    expect(planAccountDeletion("", ["users/", "users//x"])).toEqual([]);
  });

  it("2回適用した結果は1回の結果と等しい（冪等）", () => {
    fc.assert(
      fc.property(
        uid,
        fc.array(fc.oneof(pathFor("u1"), pathFor("u2"), others), { maxLength: 15 }),
        (me, all) => {
          const once = applyDeletionPlan(all, planAccountDeletion(me, all));
          const twice = applyDeletionPlan(once, planAccountDeletion(me, once));
          expect(twice).toEqual(once);
          expect(planAccountDeletion(me, once)).toEqual([]);
        },
      ),
    );
  });

  it("Auth ユーザーが存在しない場合も成功として扱い、失敗時はサインイン状態を維持する", () => {
    expect(deletionResult("ok", "user-not-found")).toEqual({ state: "done", signOut: true });
    expect(deletionResult("ok", "ok")).toEqual({ state: "done", signOut: true });
    expect(deletionResult("ok", "failed")).toEqual({ state: "failed", signOut: false });
    expect(deletionResult("timeout", "skipped")).toEqual({ state: "failed", signOut: false });
  });
});
