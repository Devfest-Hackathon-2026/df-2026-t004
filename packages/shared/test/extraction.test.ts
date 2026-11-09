import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  chunkSource,
  normalizeExtraction,
  SOURCE_AGE_BANDS,
  type ChunkMeta,
  type SourceSection,
} from "../src/index.js";

// Feature: childcare-medical-welfare-navi, Property 12: 構造化情報の欠落の正規化
// Validates: Requirements 3.7
describe("normalizeExtraction (Property 12)", () => {
  const text = fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim() !== "");
  const missing = fc.constantFrom(undefined, null, "", "   ", 0, false, {});
  const date = fc
    .date({ min: new Date("2000-01-01"), max: new Date("2099-12-31"), noInvalidDate: true })
    .map((d) => d.toISOString().slice(0, 10));
  const textKeys = ["name", "summary", "eligibility", "procedure", "sourceName"] as const;

  it("見つからない項目は null、見つかった項目は値を変えない", () => {
    fc.assert(
      fc.property(
        fc.record(
          {
            name: fc.oneof(text, missing),
            summary: fc.oneof(text, missing),
            eligibility: fc.oneof(text, missing),
            procedure: fc.oneof(text, missing),
            sourceName: fc.oneof(text, missing),
            requiredDocs: fc.oneof(fc.array(text, { minLength: 1, maxLength: 5 }), missing),
            deadline: fc.oneof(date, missing),
          },
          { requiredKeys: [] },
        ),
        (raw) => {
          const info = normalizeExtraction(raw);
          for (const key of textKeys) {
            const value: unknown = Reflect.get(raw, key);
            const present = typeof value === "string" && value.trim() !== "";
            expect(Reflect.get(info, key)).toBe(present ? value : null);
          }
          const docs: unknown = raw.requiredDocs;
          expect(info.requiredDocs).toEqual(Array.isArray(docs) ? docs : null);
          const deadline: unknown = raw.deadline;
          expect(info.deadline).toBe(
            typeof deadline === "string" && deadline !== "" && deadline.trim() !== ""
              ? deadline
              : null,
          );
          expect(info.contact).toBeNull();
        },
      ),
    );
  });

  it("推測で補わない（存在しない日付や形の違う値は null）", () => {
    const info = normalizeExtraction({
      deadline: "2026-02-30",
      requiredDocs: "母子手帳",
      contact: { phone: "042-000-0000" },
    });
    expect(info.deadline).toBeNull();
    expect(info.requiredDocs).toBeNull();
    expect(info.contact).toBeNull();
    expect(normalizeExtraction("not an object").name).toBeNull();
    expect(normalizeExtraction({ contact: { name: "子育て支援課", url: "" } }).contact).toEqual({
      name: "子育て支援課",
    });
  });
});

// Feature: childcare-medical-welfare-navi, Property 13: チャンクは原文抜粋とメタデータで構成される
// Validates: Requirements 3.4, 3.9, 3.10
describe("chunkSource (Property 13)", () => {
  const sentence = fc
    .array(fc.constantFrom("あ", "い", "児", "童", "手", "当", "a", "1", " ", "😀"), {
      minLength: 0,
      maxLength: 80,
    })
    .map((cs) => cs.join(""));
  const sectionText = fc
    .array(fc.tuple(sentence, fc.constantFrom("。", "\n", "！", "")), { maxLength: 30 })
    .map((parts) => parts.map(([s, end]) => s + end).join(""));
  const section: fc.Arbitrary<SourceSection> = fc.record(
    {
      text: sectionText,
      heading: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim() !== ""),
      pdfPage: fc.integer({ min: 1, max: 50 }),
    },
    { requiredKeys: ["text"] },
  );
  const meta: fc.Arbitrary<ChunkMeta> = fc.record({
    programId: fc.constant("city-jido-teate"),
    sourceId: fc.constant("city-jido-teate"),
    sourceUrl: fc.constant("https://kosodate.city.hachioji.tokyo.jp/a.html"),
    fetchedAt: fc.constant("2026-11-09T00:00:00.000Z"),
    contentHash: fc.hexaString({ minLength: 64, maxLength: 64 }),
    municipalityCode: fc.constantFrom("00000", "13000", "13201"),
    level: fc.constantFrom("national" as const, "tokyo" as const, "city" as const),
    category: fc.constantFrom("childcare", "medical"),
    ageBands: fc.uniqueArray(fc.constantFrom(...SOURCE_AGE_BANDS), { maxLength: 7 }),
  });
  const options = fc
    .record({
      maxChars: fc.integer({ min: 1, max: 300 }),
      minChars: fc.integer({ min: 0, max: 300 }),
    })
    .map((o) => ({ ...o, minChars: Math.min(o.minChars, o.maxChars) }));

  it("抜粋は原文の部分文字列で、必要なメタデータを持ち、構造化情報を持たない", () => {
    fc.assert(
      fc.property(fc.array(section, { maxLength: 4 }), meta, options, (sections, m, opt) => {
        const chunks = chunkSource(sections, m, opt);
        const ids = new Set<string>();
        for (const chunk of chunks) {
          const origin = sections.find(
            (s) => s.text.includes(chunk.excerpt) && s.pdfPage === chunk.pdfPage,
          );
          expect(origin).toBeDefined();
          expect(chunk.excerpt.trim()).toBe(chunk.excerpt);
          expect(chunk.excerpt.length).toBeGreaterThan(0);
          expect(chunk.excerpt.length).toBeLessThanOrEqual(opt.maxChars);
          expect(chunk).toMatchObject({
            sourceUrl: m.sourceUrl,
            fetchedAt: m.fetchedAt,
            municipalityCode: m.municipalityCode,
            level: m.level,
            category: m.category,
            contentHash: m.contentHash,
            searchable: false,
          });
          const expected: readonly string[] = m.ageBands.length > 0 ? m.ageBands : ["unknown"];
          for (const band of SOURCE_AGE_BANDS) {
            expect(Reflect.get(chunk, `band_${band}`)).toBe(expected.includes(band));
          }
          for (const key of ["summary", "eligibility", "procedure", "requiredDocs", "deadline"]) {
            expect(chunk).not.toHaveProperty(key);
          }
          ids.add(chunk.id);
        }
        expect(ids.size).toBe(chunks.length);
      }),
    );
  });

  it("空白を除く本文はすべていずれかのチャンクに入る", () => {
    fc.assert(
      fc.property(section, meta, options, (s, m, opt) => {
        const joined = chunkSource([s], m, opt)
          .map((c) => c.excerpt)
          .join("");
        expect(joined.replace(/\s/g, "")).toBe(s.text.replace(/\s/g, ""));
      }),
    );
  });

  it("年齢区分が空なら unknown を付け、見出しとページを引き継ぐ", () => {
    const [chunk] = chunkSource([{ text: "対象は妊婦の方です。", heading: "対象", pdfPage: 2 }], {
      programId: "p",
      sourceId: "s",
      sourceUrl: "https://example.jp/a.pdf",
      fetchedAt: "2026-11-09T00:00:00.000Z",
      contentHash: "abcdef0123456789",
      municipalityCode: "13201",
      level: "city",
      category: "pregnancy",
      ageBands: [],
    });
    expect(chunk).toMatchObject({
      excerpt: "対象は妊婦の方です。",
      heading: "対象",
      pdfPage: 2,
      band_unknown: true,
      band_pregnancy: false,
    });
  });
});
