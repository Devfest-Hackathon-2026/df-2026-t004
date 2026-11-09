import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AGE_BANDS,
  MAYBE_CLOSED_LABEL,
  PROGRAM_CATEGORIES,
  SOURCE_UNVERIFIED_LABEL,
  applyContentChange,
  applyVerification,
  canVerify,
  filterByCategory,
  isSearchable,
  matchPrograms,
  toProgramCard,
  toProgramView,
  touchCache,
  upcomingDeadlines,
  type Application,
  type HouseholdAgeBands,
  type MatchHousehold,
  type Program,
  type ProgramAgeBand,
} from "../src/index.js";

const isoDate = fc
  .date({
    min: new Date("2020-01-01T00:00:00Z"),
    max: new Date("2035-12-31T00:00:00Z"),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString().slice(0, 10));
const hash = fc.stringMatching(/^[0-9a-f]{8}$/);
const programBands: fc.Arbitrary<ProgramAgeBand[]> = fc.oneof(
  fc.constant([] as ProgramAgeBand[]),
  fc.constant(["unknown"] as ProgramAgeBand[]),
  fc.subarray([...AGE_BANDS], { minLength: 1 }),
);

const program: fc.Arbitrary<Program> = fc
  .record({
    id: fc.stringMatching(/^p[0-9a-z]{1,6}$/),
    level: fc.constantFrom("national" as const, "tokyo" as const, "city" as const),
    municipalityCode: fc.constantFrom("00000", "13000", "13201", "13101"),
    category: fc.constantFrom(...PROGRAM_CATEGORIES),
    ageBands: programBands,
    summary: fc.option(fc.string({ maxLength: 120 }), { nil: null }),
    deadline: fc.option(isoDate, { nil: null }),
    sourceName: fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: null }),
    sourceUrl: fc.option(fc.webUrl(), { nil: null }),
    fetchedAt: fc.option(isoDate, { nil: null }),
    verified: fc.boolean(),
    verifiedContentHash: fc.option(hash, { nil: undefined }),
    contentHash: hash,
    needsReview: fc.boolean(),
    status: fc.constantFrom("active" as const, "excluded" as const),
    updatedAt: isoDate,
  })
  .map(({ verifiedContentHash, ...r }) => ({
    ...r,
    sourceId: "s1",
    name: `[制度 ${r.id}]`,
    eligibility: null,
    procedure: null,
    requiredDocs: null,
    contact: null,
    ...(verifiedContentHash === undefined ? {} : { verifiedContentHash }),
  }));

const householdBands: fc.Arbitrary<HouseholdAgeBands> = fc
  .subarray([...AGE_BANDS])
  .map((bands) => ({ bands, unset: bands.length === 0 }));
const household: fc.Arbitrary<MatchHousehold> = fc.record({
  municipalityCode: fc.constantFrom("13201", "13101", null),
  ageBands: householdBands,
});

// Feature: childcare-medical-welfare-navi, Property 15: 確認済みの制度だけが検索・表示の対象になる
// Validates: Requirements 3.13, 3.14, 4.1, 5.1
describe("isSearchable (Property 15)", () => {
  it("verified かつ needsReview でなく active のときに限り真で、matchPrograms はそれ以外を含めない", () => {
    fc.assert(
      fc.property(fc.array(program, { maxLength: 15 }), household, isoDate, (ps, h, today) => {
        for (const p of ps)
          expect(isSearchable(p)).toBe(p.verified && !p.needsReview && p.status === "active");
        for (const m of matchPrograms(h, ps, today)) expect(isSearchable(m.program)).toBe(true);
      }),
    );
  });
});

// Feature: childcare-medical-welfare-navi, Property 16: needsReview への遷移と再確認
// Validates: Requirements 3.13, 3.15
describe("applyContentChange / applyVerification (Property 16)", () => {
  it("確認済みの制度でハッシュが変われば要再確認になり、同一なら状態は変わらない", () => {
    fc.assert(
      fc.property(program, hash, isoDate, hash, (p, h, today, next) => {
        const verified = applyVerification(p, h, today, "admin-uid");
        const changed = applyContentChange(verified, next);
        if (next === h) {
          expect(changed).toEqual(verified);
        } else {
          expect(changed.needsReview).toBe(true);
          expect(isSearchable(changed)).toBe(false);
        }
      }),
    );
  });

  it("確認を適用すると verified・needsReview・verifiedAt・verifiedContentHash がそろう", () => {
    fc.assert(
      fc.property(program, hash, isoDate, (p, h, today) => {
        const v = applyVerification(applyContentChange(p, h), h, today);
        expect(v.verified).toBe(true);
        expect(v.needsReview).toBe(false);
        expect(v.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(v.verifiedContentHash).toBe(v.contentHash);
        expect(isSearchable(v)).toBe(v.status === "active");
      }),
    );
  });
});

// Feature: childcare-medical-welfare-navi, Property 17: 確認の権限
// Validates: Requirements 3.16
describe("canVerify (Property 17)", () => {
  it("admin クレームが真のときに限り許可する", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string(),
          fc.oneof(fc.boolean(), fc.string(), fc.integer(), fc.constant(null)),
        ),
        (claims) => {
          expect(canVerify(claims)).toBe(claims["admin"] === true);
        },
      ),
    );
    expect(canVerify({ admin: "true" })).toBe(false);
    expect(canVerify({ admin: 1 })).toBe(false);
    expect(canVerify(null)).toBe(false);
    expect(canVerify({ admin: true })).toBe(true);
  });
});

// Feature: childcare-medical-welfare-navi, Property 10: 年齢区分「不明」と未設定の扱い
// Validates: Requirements 2.7, 4.2, 5.1
describe("matchPrograms: 不明と未設定 (Property 10)", () => {
  it("制度の年齢区分が unknown または空なら、除外されず要確認になる", () => {
    fc.assert(
      fc.property(fc.array(program, { maxLength: 15 }), household, isoDate, (ps, h, today) => {
        const ids = new Set(matchPrograms(h, ps, today).map((m) => m.program));
        for (const p of ps) {
          const eligibleBase =
            isSearchable(p) &&
            (p.municipalityCode === "00000" ||
              (h.municipalityCode === "13201" && ["13000", "13201"].includes(p.municipalityCode)));
          const unknown = p.ageBands.length === 0 || p.ageBands.includes("unknown");
          if (eligibleBase && unknown) expect(ids.has(p)).toBe(true);
        }
        for (const m of matchPrograms(h, ps, today)) {
          const unknown = m.program.ageBands.length === 0 || m.program.ageBands.includes("unknown");
          if (unknown) expect(m.needsCheck).toBe(true);
        }
      }),
    );
  });

  it("世帯の年齢区分が unset なら、年齢で除外せず、すべて要確認", () => {
    fc.assert(
      fc.property(fc.array(program, { maxLength: 15 }), isoDate, (ps, today) => {
        const h: MatchHousehold = {
          municipalityCode: "13201",
          ageBands: { bands: [], unset: true },
        };
        const result = matchPrograms(h, ps, today);
        expect(result.length).toBe(
          ps.filter(
            (p) => isSearchable(p) && ["00000", "13000", "13201"].includes(p.municipalityCode),
          ).length,
        );
        expect(result.every((m) => m.needsCheck)).toBe(true);
      }),
    );
  });
});

// Feature: childcare-medical-welfare-navi, Property 18: ダッシュボードの候補判定
// Validates: Requirements 4.1, 4.3, 4.4
describe("matchPrograms (Property 18)", () => {
  it("確認済みで自治体・年齢区分の条件を満たす制度だけを含み、ラベルは常に「対象の可能性」", () => {
    fc.assert(
      fc.property(fc.array(program, { maxLength: 15 }), household, isoDate, (ps, h, today) => {
        const codes = h.municipalityCode === "13201" ? ["00000", "13000", "13201"] : ["00000"];
        const expected = ps.filter((p) => {
          if (!isSearchable(p) || !codes.includes(p.municipalityCode)) return false;
          if (h.ageBands.unset || p.ageBands.length === 0 || p.ageBands.includes("unknown"))
            return true;
          return p.ageBands.some((b) => (h.ageBands.bands as readonly string[]).includes(b));
        });
        const result = matchPrograms(h, ps, today);
        expect(result.map((m) => m.program)).toEqual(expected);
        expect(result.every((m) => m.label === "対象の可能性")).toBe(true);
      }),
    );
  });

  it("締切を過ぎた制度は除外されず、注意が付く", () => {
    fc.assert(
      fc.property(fc.array(program, { maxLength: 15 }), household, isoDate, (ps, h, today) => {
        for (const m of matchPrograms(h, ps, today)) {
          expect(m.maybeClosed).toBe(m.program.deadline !== null && m.program.deadline < today);
          expect(toProgramCard(m.program, m).maybeClosed).toBe(m.maybeClosed);
        }
      }),
    );
    expect(MAYBE_CLOSED_LABEL).toBe("受付が終了している可能性があります");
  });
});

// Feature: childcare-medical-welfare-navi, Property 21: カテゴリ絞り込み
// Validates: Requirements 4.9, 4.10
describe("filterByCategory (Property 21)", () => {
  it("結果はすべて選んだカテゴリに一致し、解除すると元に戻る。判定の前に適用される", () => {
    fc.assert(
      fc.property(
        fc.array(program, { maxLength: 15 }),
        fc.constantFrom(...PROGRAM_CATEGORIES),
        household,
        isoDate,
        (ps, c, h, today) => {
          const filtered = filterByCategory(ps, c);
          expect(filtered.every((p) => p.category === c)).toBe(true);
          expect(filterByCategory(ps, null)).toEqual(ps);
          expect(matchPrograms(h, ps, today, c)).toEqual(matchPrograms(h, filtered, today));
          expect(matchPrograms(h, ps, today, c).every((m) => m.program.category === c)).toBe(true);
        },
      ),
    );
  });
});

// Feature: childcare-medical-welfare-navi, Property 19: Program_Card の整形
// Validates: Requirements 4.5
describe("toProgramCard (Property 19)", () => {
  it("要約は60文字以内、更新日は YYYY/MM/DD、行政レベル・対象・出典名・対象の可能性を含む", () => {
    fc.assert(
      fc.property(program, (p) => {
        const card = toProgramCard(p);
        if (card.summary !== null) expect([...card.summary].length).toBeLessThanOrEqual(60);
        if (p.summary !== null && [...p.summary].length <= 60) expect(card.summary).toBe(p.summary);
        expect(card.updatedAt).toMatch(/^\d{4}\/\d{2}\/\d{2}$/);
        expect(["国", "東京都", "市"]).toContain(card.levelLabel);
        expect(card.targetLabel.length).toBeGreaterThan(0);
        expect(card.sourceName.length).toBeGreaterThan(0);
        expect(card.eligibilityLabel).toBe("対象の可能性");
      }),
    );
  });
});

// Feature: childcare-medical-welfare-navi, Property 20: 締切の並び替えと上限
// Validates: Requirements 4.8
describe("upcomingDeadlines (Property 20)", () => {
  const application: fc.Arbitrary<Application> = fc.record({
    programId: fc.stringMatching(/^p[0-9]{1,3}$/),
    status: fc.constantFrom("not_started" as const, "in_progress" as const, "done" as const),
    deadline: fc.option(isoDate, { nil: null }),
    tasks: fc.array(fc.record({ id: fc.string(), label: fc.string(), done: fc.boolean() }), {
      maxLength: 4,
    }),
  });

  it("締切の昇順で最大5件、完了した申請を含めない", () => {
    fc.assert(
      fc.property(fc.array(application, { maxLength: 20 }), (apps) => {
        const r = upcomingDeadlines(apps);
        expect(r.length).toBe(Math.min(5, apps.filter((a) => a.status === "in_progress").length));
        expect(r.every((a) => a.status === "in_progress")).toBe(true);
        const dated = r.map((a) => a.deadline).filter((d): d is string => d !== null);
        expect(dated).toEqual([...dated].sort());
        // 締切の無いものは、締切のあるものより後ろ
        const firstNull = r.findIndex((a) => a.deadline === null);
        if (firstNull >= 0) expect(r.slice(firstNull).every((a) => a.deadline === null)).toBe(true);
      }),
    );
  });
});

// Feature: childcare-medical-welfare-navi, Property 35: 出典の表示モデル
// Validates: Requirements 10.5, 10.6
describe("toProgramView (Property 35)", () => {
  it("出典URLと取得日を含み、どちらかが欠けていれば「出典未確認」と窓口確認の注意書きを必ず含む", () => {
    fc.assert(
      fc.property(program, (p) => {
        const v = toProgramView(p);
        expect(v.notice).toContain("問い合わせ窓口で確認");
        const complete = p.sourceUrl !== null && p.fetchedAt !== null;
        if (complete) {
          expect(v.source.url).toBe(p.sourceUrl);
          expect(v.source.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(v.source.label).toBeNull();
        } else {
          expect(v.source.label).toBe(SOURCE_UNVERIFIED_LABEL);
          expect(v.notice).toContain(SOURCE_UNVERIFIED_LABEL);
        }
      }),
    );
  });
});

// Feature: childcare-medical-welfare-navi, Property 46: オフラインキャッシュの上限
// Validates: Requirements 12.4
describe("touchCache (Property 46)", () => {
  it("件数は50以下、直近に開いたものは先頭に残り、削除されるのは最も長く開かれていないもの", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 80 }).map(String), { maxLength: 200 }),
        (opens) => {
          let cache: string[] = [];
          for (const id of opens) {
            const before = cache;
            cache = touchCache(cache, id);
            expect(cache.length).toBeLessThanOrEqual(50);
            expect(cache[0]).toBe(id);
            expect(new Set(cache).size).toBe(cache.length);
            // 消えたものは、前のキャッシュの末尾（最も古いもの）だけ
            const removed = before.filter((x) => !cache.includes(x));
            expect(removed.length).toBeLessThanOrEqual(1);
            if (removed.length === 1) expect(removed[0]).toBe(before[before.length - 1]);
          }
        },
      ),
    );
  });
});
