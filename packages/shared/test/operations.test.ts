import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  dateKeyJst,
  evaluateQuota,
  needsSwitchRefresh,
  OPS_STOPPED,
  resolveSwitch,
} from "../src/index.js";

const MIN = Date.UTC(2000, 0, 1);
const MAX = Date.UTC(2100, 0, 1);

// Feature: childcare-medical-welfare-navi, Property 36: 日本時間の日付キー
// Validates: Requirements 13.8
describe("dateKeyJst (Property 36)", () => {
  it("UTC+9 の暦日を返す", () => {
    fc.assert(
      fc.property(fc.integer({ min: MIN, max: MAX }), (t) => {
        const jst = new Date(t + 9 * 3600_000);
        const expected = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;
        expect(dateKeyJst(new Date(t))).toBe(expected);
      }),
    );
  });

  it("UTC の 15:00（日本時間の 0:00）をまたぐと日付が変わる", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 36_000 }), (day) => {
        const boundary = MIN + day * 86_400_000 + 15 * 3600_000;
        const before = dateKeyJst(new Date(boundary - 1));
        const after = dateKeyJst(new Date(boundary));
        expect(after > before).toBe(true);
        expect(dateKeyJst(new Date(boundary - 15 * 3600_000))).toBe(before);
      }),
    );
    expect(dateKeyJst(new Date("2026-11-09T14:59:59.999Z"))).toBe("2026-11-09");
    expect(dateKeyJst(new Date("2026-11-09T15:00:00.000Z"))).toBe("2026-11-10");
  });

  it("不正な日時は例外", () => {
    expect(() => dateKeyJst(new Date("x"))).toThrow(RangeError);
  });
});

// Feature: childcare-medical-welfare-navi, Property 37: 日次上限
// Validates: Requirements 13.8, 13.9, 13.12
describe("evaluateQuota (Property 37)", () => {
  const n = fc.integer({ min: 0, max: 600 });
  const limits = fc.record({
    perUserPerDay: fc.integer({ min: 1, max: 30 }),
    globalPerDay: fc.integer({ min: 1, max: 600 }),
  });

  it("どちらかが上限以上なら理由つきで拒否し、両方未満なら受け付けて1ずつ増やす", () => {
    fc.assert(
      fc.property(n, n, limits, (user, global, l) => {
        const d = evaluateQuota({ user, global }, l);
        if (user >= l.perUserPerDay) expect(d).toEqual({ ok: false, reason: "quota_user" });
        else if (global >= l.globalPerDay) expect(d).toEqual({ ok: false, reason: "quota_global" });
        else expect(d).toEqual({ ok: true, next: { user: user + 1, global: global + 1 } });
      }),
    );
  });

  it("受け付けた回数は上限を超えない（1日に送れる質問はユーザーごとに上限まで）", () => {
    fc.assert(
      fc.property(limits, fc.integer({ min: 0, max: 100 }), (l, attempts) => {
        let counts = { user: 0, global: 0 };
        let accepted = 0;
        for (let i = 0; i < attempts; i++) {
          const d = evaluateQuota(counts, l);
          if (d.ok) {
            counts = d.next;
            accepted += 1;
          }
        }
        expect(accepted).toBe(Math.min(attempts, l.perUserPerDay, l.globalPerDay));
      }),
    );
  });
});

// Feature: childcare-medical-welfare-navi, Property 38: 運営スイッチ
// Validates: Requirements 13.11, 13.12
describe("resolveSwitch (Property 38)", () => {
  const value = fc.record({ aiEnabled: fc.boolean(), collectionEnabled: fc.boolean() });
  const maxStaleSec = fc.integer({ min: 1, max: 60 });

  it("読み直せなかったとき、キャッシュが maxStaleSec 以内ならその値、古ければ停止", () => {
    fc.assert(
      fc.property(
        fc.option(value, { nil: null }),
        fc.integer({ min: 0, max: 120_000 }),
        maxStaleSec,
        (cached, age, stale) => {
          const now = MIN + 1_000_000;
          const cache = cached === null ? null : { value: cached, fetchedAtMs: now - age };
          const r = resolveSwitch({ cache, nowMs: now, maxStaleSec: stale, refetched: null });
          if (cached !== null && age <= stale * 1000) expect(r.value).toEqual(cached);
          else expect(r.value).toEqual(OPS_STOPPED);
        },
      ),
    );
  });

  it("読み直せたときはその値を使い、キャッシュの取得時刻を更新する", () => {
    fc.assert(
      fc.property(fc.option(value, { nil: null }), value, maxStaleSec, (cached, fresh, stale) => {
        const now = MIN + 1_000_000;
        const cache = cached === null ? null : { value: cached, fetchedAtMs: 0 };
        const r = resolveSwitch({ cache, nowMs: now, maxStaleSec: stale, refetched: fresh });
        expect(r.value).toEqual(fresh);
        expect(r.cache).toEqual({ value: fresh, fetchedAtMs: now });
      }),
    );
  });

  it("停止のときは AI 呼び出しも新規の取得も開始しない値になる", () => {
    expect(OPS_STOPPED).toEqual({ aiEnabled: false, collectionEnabled: false });
    expect(Object.isFrozen(OPS_STOPPED)).toBe(true);
  });

  it("キャッシュが cacheTtlSec より古い、または無いときに読み直す", () => {
    const now = MIN + 100_000;
    const v = { aiEnabled: true, collectionEnabled: true };
    expect(needsSwitchRefresh(null, now, 5)).toBe(true);
    expect(needsSwitchRefresh({ value: v, fetchedAtMs: now - 5000 }, now, 5)).toBe(false);
    expect(needsSwitchRefresh({ value: v, fetchedAtMs: now - 5001 }, now, 5)).toBe(true);
  });
});
