// 運営スイッチのキャッシュと受付判定（Requirement 13.8, 13.9, 13.11, 13.12）
import type { OpsSwitch } from "@hachioji-gov/shared";
import { describe, expect, it } from "vitest";
import {
  admitQuestion,
  createSwitchReader,
  MemoryUsageStore,
  usageExpireAt,
  type OpsConfigStore,
} from "../src/index.js";

const ON: OpsSwitch = { aiEnabled: true, collectionEnabled: true };
const OFF: OpsSwitch = { aiEnabled: false, collectionEnabled: true };

function store(values: (OpsSwitch | null)[]) {
  const s = {
    reads: 0,
    async read() {
      const v = values[Math.min(s.reads, values.length - 1)];
      s.reads += 1;
      if (v === null || v === undefined) throw new Error("read failed");
      return v;
    },
  };
  return s satisfies OpsConfigStore;
}

describe("createSwitchReader", () => {
  it("5秒はキャッシュを使い、過ぎたら読み直す", async () => {
    let now = 0;
    const s = store([ON, OFF]);
    const reader = createSwitchReader(s, { cacheTtlSec: 5, maxStaleSec: 10 }, () => now);
    expect(await reader.get()).toEqual(ON);
    now = 5000;
    expect(await reader.get()).toEqual(ON);
    expect(s.reads).toBe(1);
    now = 5001;
    expect(await reader.get()).toEqual(OFF);
    expect(s.reads).toBe(2);
  });

  it("読み直しに失敗したら、10秒以内はキャッシュ、それより古ければ停止", async () => {
    let now = 0;
    const s = store([ON, null]);
    const reader = createSwitchReader(s, { cacheTtlSec: 5, maxStaleSec: 10 }, () => now);
    await reader.get();
    now = 8000;
    expect(await reader.get()).toEqual(ON);
    now = 10_001;
    expect(await reader.get()).toEqual({ aiEnabled: false, collectionEnabled: false });
  });

  it("一度も読めなければ停止", async () => {
    const reader = createSwitchReader(store([null]), { cacheTtlSec: 5, maxStaleSec: 10 }, () => 0);
    expect((await reader.get()).aiEnabled).toBe(false);
  });
});

describe("admitQuestion", () => {
  const limits = { perUserPerDay: 2, globalPerDay: 3 };
  const now = new Date("2026-11-09T14:59:59.000Z"); // 日本時間 23:59:59

  it("停止中は回数を使わずに ops_stopped", async () => {
    const usage = new MemoryUsageStore();
    const switches = createSwitchReader(store([OFF]), { cacheTtlSec: 5, maxStaleSec: 10 });
    expect(await admitQuestion("a", { switches, usage, limits, now })).toEqual({
      ok: false,
      reason: "ops_stopped",
    });
    expect(usage.counts.size).toBe(0);
  });

  it("ユーザー別・全体の上限で止め、日本時間の日付が変わると戻る", async () => {
    const usage = new MemoryUsageStore();
    const switches = createSwitchReader(store([ON]), { cacheTtlSec: 5, maxStaleSec: 10 });
    const admit = (uid: string, at = now) =>
      admitQuestion(uid, { switches, usage, limits, now: at });
    expect(await admit("a")).toEqual({ ok: true });
    expect(await admit("a")).toEqual({ ok: true });
    expect(await admit("a")).toEqual({ ok: false, reason: "quota_user" });
    expect(await admit("b")).toEqual({ ok: true });
    expect(await admit("c")).toEqual({ ok: false, reason: "quota_global" });
    expect(usage.counts.get("usage/2026-11-09")).toBe(3);
    // 日本時間の翌日0時
    expect(await admit("a", new Date("2026-11-09T15:00:00.000Z"))).toEqual({ ok: true });
  });
});

describe("usageExpireAt", () => {
  it("その日（日本時間）の終わりの2日後。Timestamp 型", () => {
    const t = usageExpireAt("2026-11-09");
    expect(t.toDate().toISOString()).toBe("2026-11-11T15:00:00.000Z");
  });

  it("形式が違う日付は例外", () => {
    expect(() => usageExpireAt("2026/11/09")).toThrow(RangeError);
  });
});
