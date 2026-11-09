import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decideSourceAction,
  isDue,
  NOT_FOUND_EXCLUDE_THRESHOLD,
  planFetch,
  type FetchTarget,
} from "../src/index.js";

const HOUR_MS = 60 * 60 * 1000;
const BASE = Date.UTC(2026, 10, 9, 0, 0, 0);

// Feature: childcare-medical-welfare-navi, Property 11: 取得の判定と置換の決定
// Validates: Requirements 3.1, 3.2, 3.3, 3.6
describe("isDue (Property 11)", () => {
  const interval = fc.integer({ min: 1, max: 24 * 30 });
  const elapsedMs = fc.integer({ min: 0, max: 24 * 60 * HOUR_MS });

  it("取得間隔が経過したときだけ真になる", () => {
    fc.assert(
      fc.property(interval, elapsedMs, (hours, elapsed) => {
        const source = {
          status: "active" as const,
          intervalHours: hours,
          lastFetchedAt: new Date(BASE).toISOString(),
        };
        expect(isDue(source, new Date(BASE + elapsed))).toBe(elapsed >= hours * HOUR_MS);
      }),
    );
  });

  it("一度も取得していない情報源は取得する", () => {
    fc.assert(
      fc.property(interval, (hours) => {
        expect(isDue({ status: "active", intervalHours: hours }, new Date(BASE))).toBe(true);
      }),
    );
  });

  it("除外済みの情報源は取得しない", () => {
    fc.assert(
      fc.property(interval, elapsedMs, (hours, elapsed) => {
        const source = {
          status: "excluded" as const,
          intervalHours: hours,
          lastFetchedAt: new Date(BASE).toISOString(),
        };
        expect(isDue(source, new Date(BASE + elapsed))).toBe(false);
        expect(isDue({ status: "excluded", intervalHours: hours }, new Date(BASE))).toBe(false);
      }),
    );
  });
});

describe("decideSourceAction (Property 11)", () => {
  const hash = fc.stringMatching(/^[0-9a-f]{8,64}$/);
  const miss = fc.integer({ min: 0, max: 5 });

  it("ハッシュが同じなら skip し、見つからない回数を戻す", () => {
    fc.assert(
      fc.property(hash, miss, (h, m) => {
        expect(decideSourceAction(h, h, m)).toEqual({ action: "skip", missCount: 0 });
      }),
    );
  });

  it("ハッシュが異なる、または前回の内容がなければ replace", () => {
    fc.assert(
      fc.property(fc.option(hash, { nil: null }), hash, miss, (prev, next, m) => {
        fc.pre(prev !== next);
        expect(decideSourceAction(prev, next, m)).toEqual({ action: "replace", missCount: 0 });
      }),
    );
  });

  it("見つからないが2回連続したら exclude、1回目は miss", () => {
    fc.assert(
      fc.property(fc.option(hash, { nil: null }), miss, (prev, m) => {
        const result = decideSourceAction(prev, null, m);
        expect(result.missCount).toBe(m + 1);
        expect(result.action).toBe(m + 1 >= NOT_FOUND_EXCLUDE_THRESHOLD ? "exclude" : "miss");
      }),
    );
    expect(decideSourceAction("a", null, 0).action).toBe("miss");
    expect(decideSourceAction("a", null, 1).action).toBe("exclude");
  });
});

// Feature: childcare-medical-welfare-navi, Property 14: 取得上限
// Validates: Requirements 3.11, 3.12
describe("planFetch (Property 14)", () => {
  type T = FetchTarget & { key: number };
  const targets = fc
    .array(
      fc.record({
        format: fc.constantFrom("html" as const, "pdf" as const),
        groupId: fc.constantFrom("a", "b", "c"),
      }),
      { maxLength: 250 },
    )
    .map((list) => list.map((t, i): T => ({ ...t, url: `https://example.jp/${i}`, key: i })));
  const limits = fc.record({
    maxPagesPerRun: fc.integer({ min: 1, max: 120 }),
    maxPdfPerSource: fc.integer({ min: 1, max: 12 }),
  });

  it("上限を守り、選んだものと後回しの和が元の一覧に等しく、重複しない", () => {
    fc.assert(
      fc.property(targets, limits, (list, lim) => {
        const plan = planFetch(list, lim);
        expect(plan.selected.length).toBeLessThanOrEqual(lim.maxPagesPerRun);
        for (const group of ["a", "b", "c"]) {
          const pdfs = plan.selected.filter((t) => t.format === "pdf" && t.groupId === group);
          expect(pdfs.length).toBeLessThanOrEqual(lim.maxPdfPerSource);
        }
        const keys = [...plan.selected, ...plan.deferred.map((d) => d.target)].map((t) => t.key);
        expect(keys.length).toBe(list.length);
        expect([...keys].sort((x, y) => x - y)).toEqual(list.map((t) => t.key));
      }),
    );
  });

  it("実際の上限（100ページ・PDF10件）で、超えた分に理由が付く", () => {
    const list: T[] = Array.from({ length: 120 }, (_, i) => ({
      url: `https://example.jp/${i}`,
      format: i < 15 ? "pdf" : "html",
      groupId: i < 15 ? "g" : `h${i}`,
      key: i,
    }));
    const plan = planFetch(list, { maxPagesPerRun: 100, maxPdfPerSource: 10 });
    expect(plan.selected).toHaveLength(100);
    expect(plan.deferred.filter((d) => d.reason === "maxPdfPerSource")).toHaveLength(5);
    expect(plan.deferred.filter((d) => d.reason === "maxPagesPerRun")).toHaveLength(15);
  });
});
