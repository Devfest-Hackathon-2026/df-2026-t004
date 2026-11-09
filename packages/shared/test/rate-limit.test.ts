import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createRateLimiter, evaluateRateLimit, type RateLimitEntry } from "../src/index.js";

const BASE = Date.UTC(2026, 10, 9, 0, 0, 0);

// 時刻の昇順に並んだリクエスト列（窓の数個分）
const times = (windowSec: number) =>
  fc
    .array(fc.integer({ min: 0, max: windowSec * 1000 * 4 }), { maxLength: 80 })
    .map((list) => list.sort((a, b) => a - b).map((t) => BASE + t));

// Feature: childcare-medical-welfare-navi, Property 2: レート制限
// Validates: Requirements 1.9, 1.10
describe("evaluateRateLimit (Property 2)", () => {
  const options = fc.record({
    limit: fc.integer({ min: 1, max: 10 }),
    windowSec: fc.integer({ min: 1, max: 120 }),
  });

  it("同じ窓で上限を超えたリクエストを拒否し、retryAfterSec は 1 以上・窓の長さ以下", () => {
    fc.assert(
      fc.property(
        options.chain((o) => fc.tuple(fc.constant(o), times(o.windowSec))),
        ([o, list]) => {
          let entry: RateLimitEntry | undefined;
          const accepted = new Map<number, number>();
          for (const now of list) {
            const windowIndex = Math.floor(now / (o.windowSec * 1000));
            const before = accepted.get(windowIndex) ?? 0;
            const d = evaluateRateLimit(entry, now, o);
            entry = d.entry;
            expect(d.allowed).toBe(before < o.limit);
            if (d.allowed) {
              accepted.set(windowIndex, before + 1);
              expect(d.remaining).toBe(o.limit - before - 1);
              expect(d.retryAfterSec).toBe(0);
            } else {
              expect(d.retryAfterSec).toBeGreaterThanOrEqual(1);
              expect(d.retryAfterSec).toBeLessThanOrEqual(o.windowSec);
            }
          }
        },
      ),
    );
  });

  it("ユーザーの状態と IP の状態は互いに影響しない", () => {
    const request = fc.record({
      kind: fc.constantFrom("user" as const, "ip" as const),
      key: fc.constantFrom("a", "b"),
      t: fc.integer({ min: 0, max: 240_000 }),
    });
    fc.assert(
      fc.property(fc.array(request, { maxLength: 60 }), (raw) => {
        const list = [...raw].sort((x, y) => x.t - y.t);
        const make = () => createRateLimiter({ limit: 3, windowSec: 60, maxEntries: 100 });
        // 混ぜて流した場合
        const mixed = { user: make(), ip: make() };
        const together = list.map((r) => mixed[r.kind].check(r.key, BASE + r.t).allowed);
        // 種類ごとに別々に流した場合
        for (const kind of ["user", "ip"] as const) {
          const alone = make();
          const results = list
            .filter((r) => r.kind === kind)
            .map((r) => alone.check(r.key, BASE + r.t).allowed);
          expect(together.filter((_, i) => list.at(i)?.kind === kind)).toEqual(results);
        }
      }),
    );
  });

  it("窓が過ぎたエントリを捨て、エントリ数は上限を超えない", () => {
    const limiter = createRateLimiter({ limit: 1, windowSec: 60, maxEntries: 3 });
    for (let i = 0; i < 10; i++) limiter.check(`ip${i}`, BASE);
    expect(limiter.size()).toBeLessThanOrEqual(3);
    limiter.check("later", BASE + 61_000);
    expect(limiter.size()).toBe(1);
    // 捨てられたキーは新しい窓で受け付けられる
    expect(limiter.check("later", BASE + 61_500).allowed).toBe(false);
    expect(limiter.check("later", BASE + 121_000).allowed).toBe(true);
  });
});
