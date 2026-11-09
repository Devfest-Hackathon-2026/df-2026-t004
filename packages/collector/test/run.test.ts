import { describe, expect, it } from "vitest";
import type { SourceDoc } from "@hachioji-gov/shared";
import {
  FakeEmbedder,
  FakeExtractor,
  FixedClock,
  MemoryFetcher,
  MemoryOps,
  MemoryStore,
  runCollection,
  type CollectorDeps,
  type CollectorSettings,
  type FetchResult,
} from "../src/index.js";
import { makePdf } from "./support/pdf.js";

const START = new Date("2026-11-09T00:00:00.000Z");
const DAY_MS = 25 * 60 * 60 * 1000;
const ON = { aiEnabled: true, collectionEnabled: true };
const OFF = { aiEnabled: true, collectionEnabled: false };

const HTML_URL = "https://www.city.hachioji.tokyo.jp/kosodate/a.html";
const PDF_URL = "https://www.city.hachioji.tokyo.jp/kosodate/a.pdf";

const SETTINGS: CollectorSettings = {
  maxPagesPerRun: 100,
  maxPdfPerSource: 10,
  maxRetries: 3,
  timeoutSec: 30,
  embedding: { model: "gemini-embedding-001", dimensions: 8, version: "v1" },
};

function source(over: Partial<SourceDoc> = {}): SourceDoc {
  return {
    id: "s1",
    url: HTML_URL,
    municipalityCode: "13201",
    level: "city",
    format: "html",
    category: "childcare",
    ageBands: ["age_0_2"],
    title: "児童手当",
    relatedSourceId: null,
    intervalHours: 24,
    status: "active",
    missCount: 0,
    ...over,
  };
}

function html(body: string): FetchResult {
  return {
    kind: "ok",
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: new TextEncoder().encode(`<html><body><main>${body}</main></body></html>`),
  };
}

const PAGE_V1 = html("<h2>児童手当</h2><p>中学生までの子を養育する人に支給します。</p>");
const PAGE_V2 = html("<h2>児童手当</h2><p>高校生までの子を養育する人に支給します。</p>");

function setup(sources: SourceDoc[], responses: [string, FetchResult | FetchResult[]][] = []) {
  const store = new MemoryStore(sources);
  const fetcher = new MemoryFetcher(new Map(responses));
  const embedder = new FakeEmbedder();
  const extractor = new FakeExtractor({ name: "児童手当", summary: "子育て世帯への手当" });
  const clock = new FixedClock(START);
  const ops = new MemoryOps([ON]);
  const waits: number[] = [];
  const deps: CollectorDeps = {
    store,
    fetcher,
    embedder,
    extractor,
    clock,
    ops,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
  return { store, fetcher, embedder, extractor, clock, ops, waits, deps };
}

// 確認済みにして、チャンクを検索対象にする（admin の verify と同じ結果）
async function verify(store: MemoryStore, programId: string): Promise<void> {
  const p = store.programs.get(programId);
  if (p === undefined) throw new Error("no program");
  store.programs.set(programId, {
    ...p,
    verified: true,
    verifiedAt: "2026-11-09",
    verifiedBy: "operator-uid",
    verifiedContentHash: p.contentHash,
    needsReview: false,
  });
  await store.setSearchable(programId, true);
}

const later = (clock: FixedClock) => {
  clock.time = new Date(clock.time.getTime() + DAY_MS);
};

describe("runCollection", () => {
  it("新しい情報源から制度とチャンクを作る。チャンクは確認前なので検索対象にしない", async () => {
    const t = setup([source()], [[HTML_URL, PAGE_V1]]);
    const summary = await runCollection(t.deps, SETTINGS);
    expect(summary).toMatchObject({ stopped: false, fetched: 1, replaced: 1, errors: 0 });

    const program = t.store.programs.get("s1");
    expect(program).toMatchObject({
      name: "児童手当",
      summary: "子育て世帯への手当",
      eligibility: null,
      verified: false,
      needsReview: false,
      status: "active",
      ageBands: ["age_0_2"],
      sourceUrl: HTML_URL,
    });
    const chunks = [...t.store.chunks.values()];
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.searchable).toBe(false);
      expect(c.programId).toBe("s1");
      expect(c.heading).toBe("児童手当");
      expect(c.contentHash).toBe(program?.contentHash);
      expect(c.band_age_0_2).toBe(true);
      expect(c.vectors["v1"]).toHaveLength(8);
      expect(c.embeddingMeta["v1"]).toEqual({
        model: "gemini-embedding-001",
        dimensions: 8,
        createdAt: START.toISOString(),
      });
    }
    expect(t.store.sources.get("s1")).toMatchObject({
      lastHash: program?.contentHash,
      lastFetchedAt: START.toISOString(),
      missCount: 0,
    });
    expect(t.store.logs).toEqual([
      { sourceId: "s1", url: HTML_URL, at: START.toISOString(), result: "replaced", count: 1 },
    ]);
  });

  it("内容が同じなら、チャンクを変えず最終取得日時だけ更新する", async () => {
    const t = setup([source()], [[HTML_URL, PAGE_V1]]);
    await runCollection(t.deps, SETTINGS);
    const before = structuredClone([...t.store.chunks.entries()]);
    const calls = t.embedder.calls;
    later(t.clock);
    const summary = await runCollection(t.deps, SETTINGS);
    expect(summary).toMatchObject({ unchanged: 1, replaced: 0 });
    expect([...t.store.chunks.entries()]).toEqual(before);
    expect(t.embedder.calls).toBe(calls);
    expect(t.store.sources.get("s1")?.lastFetchedAt).toBe(t.clock.now().toISOString());
  });

  it("取得期限が来ていない情報源は取得しない", async () => {
    const t = setup([source()], [[HTML_URL, PAGE_V1]]);
    await runCollection(t.deps, SETTINGS);
    const summary = await runCollection(t.deps, SETTINGS);
    expect(summary.fetched).toBe(0);
    expect(t.fetcher.calls).toHaveLength(1);
  });

  it("取得に失敗したら最大3回再試行し、それでも失敗ならチャンクを変えずに記録する", async () => {
    const t = setup([source()], [[HTML_URL, PAGE_V1]]);
    await runCollection(t.deps, SETTINGS);
    const before = structuredClone([...t.store.chunks.entries()]);
    t.fetcher.responses.set(HTML_URL, { kind: "error", reason: "timeout", retryable: true });
    later(t.clock);
    const summary = await runCollection(t.deps, SETTINGS);
    expect(summary).toMatchObject({ errors: 1, replaced: 0 });
    // 最初の1回 + 再試行3回
    expect(t.fetcher.calls).toHaveLength(1 + 4);
    expect(t.waits).toEqual([1000, 2000, 4000]);
    expect([...t.store.chunks.entries()]).toEqual(before);
    expect(t.store.sources.get("s1")?.missCount).toBe(0);
    expect(t.store.logs.at(-1)).toEqual({
      sourceId: "s1",
      url: HTML_URL,
      at: t.clock.now().toISOString(),
      result: "error",
      reason: "timeout",
    });
  });

  it("再試行の途中で成功すれば、それを使う。再試行しない失敗はすぐ記録する", async () => {
    const t = setup(
      [source(), source({ id: "s2", url: `${HTML_URL}?b` })],
      [
        [HTML_URL, [{ kind: "error", reason: "http_503", retryable: true }, PAGE_V1]],
        [`${HTML_URL}?b`, { kind: "error", reason: "http_403", retryable: false }],
      ],
    );
    const summary = await runCollection(t.deps, SETTINGS);
    expect(summary).toMatchObject({ replaced: 1, errors: 1 });
    expect(t.fetcher.calls).toEqual([HTML_URL, HTML_URL, `${HTML_URL}?b`]);
  });

  it("1つの情報源の失敗（取得・抽出・保存）で他の情報源を止めない", async () => {
    const urls = ["a", "b", "c"].map((x) => `${HTML_URL}?${x}`);
    const t = setup(
      urls.map((url, i) => source({ id: `s${i}`, url })),
      [
        [
          urls[0] ?? "",
          { kind: "ok", status: 200, contentType: "text/html", body: new Uint8Array() },
        ],
        [urls[1] ?? "", PAGE_V1],
        [urls[2] ?? "", PAGE_V2],
      ],
    );
    t.store.failOn.add("listSources");
    expect((await runCollection(t.deps, SETTINGS).catch(() => null)) === null).toBe(true);
    t.store.failOn.clear();

    const summary = await runCollection(t.deps, SETTINGS);
    expect(summary).toMatchObject({ fetched: 3, replaced: 2, errors: 1 });
    expect(t.store.logs.find((l) => l.sourceId === "s0")).toMatchObject({
      result: "error",
      reason: "empty_content",
    });
  });

  it("見つからない応答が1回なら保持し、2回連続で検索対象から外して除外する", async () => {
    const pdf = source({
      id: "p1",
      url: PDF_URL,
      format: "pdf",
      relatedSourceId: "s1",
    });
    const t = setup(
      [source(), pdf],
      [
        [HTML_URL, PAGE_V1],
        [
          PDF_URL,
          { kind: "ok", status: 200, contentType: "application/pdf", body: makePdf(["Hi"]) },
        ],
      ],
    );
    await runCollection(t.deps, SETTINGS);
    await verify(t.store, "s1");

    t.fetcher.responses.set(HTML_URL, { kind: "not_found", status: 404 });
    later(t.clock);
    expect(await runCollection(t.deps, SETTINGS)).toMatchObject({ notFound: 1, unchanged: 1 });
    expect(t.store.sources.get("s1")?.missCount).toBe(1);
    expect([...t.store.chunks.values()].every((c) => c.searchable)).toBe(true);

    later(t.clock);
    expect(await runCollection(t.deps, SETTINGS)).toMatchObject({ excluded: 1 });
    expect(t.store.sources.get("s1")?.status).toBe("excluded");
    expect(t.store.programs.get("s1")?.status).toBe("excluded");
    // 制度に足した PDF のチャンクも外れる
    expect([...t.store.chunks.values()].some((c) => c.searchable)).toBe(false);
    expect(t.store.logs.filter((l) => l.sourceId === "s1").at(-1)).toMatchObject({
      result: "excluded",
      reason: "http_404",
    });
  });

  it("見つからない応答のあとに取得できれば、連続回数を戻す", async () => {
    const t = setup([source({ missCount: 1, lastHash: "x" })], [[HTML_URL, PAGE_V1]]);
    await runCollection(t.deps, SETTINGS);
    expect(t.store.sources.get("s1")?.missCount).toBe(0);
  });

  it("1回の実行のページ数の上限を超えた対象は取得せず、URL と理由を記録する", async () => {
    const urls = ["a", "b", "c"].map((x) => `${HTML_URL}?${x}`);
    const t = setup(
      urls.map((url, i) => source({ id: `s${i}`, url })),
      urls.map((url) => [url, PAGE_V1] as [string, FetchResult]),
    );
    const summary = await runCollection(t.deps, { ...SETTINGS, maxPagesPerRun: 2 });
    expect(summary).toMatchObject({ fetched: 2, deferred: 1 });
    expect(t.fetcher.calls).toEqual(urls.slice(0, 2));
    expect(t.store.logs[0]).toEqual({
      sourceId: "s2",
      url: urls[2],
      at: START.toISOString(),
      result: "deferred",
      reason: "maxPagesPerRun",
    });
    // 次の実行で取得する
    t.fetcher.calls.length = 0;
    await runCollection(t.deps, { ...SETTINGS, maxPagesPerRun: 2 });
    expect(t.fetcher.calls).toEqual([urls[2]]);
  });

  it("同じ制度の PDF の上限を超えた分は記録して後回しにする。HTML は PDF より先に処理する", async () => {
    const pdfs = [1, 2].map((n) =>
      source({ id: `p${n}`, url: `${PDF_URL}?${n}`, format: "pdf", relatedSourceId: "s1" }),
    );
    const ok: FetchResult = {
      kind: "ok",
      status: 200,
      contentType: "application/pdf",
      body: makePdf(["Page"]),
    };
    const t = setup(
      [...pdfs, source()],
      [[HTML_URL, PAGE_V1], ...pdfs.map((p) => [p.url, ok] as [string, FetchResult])],
    );
    const summary = await runCollection(t.deps, { ...SETTINGS, maxPdfPerSource: 1 });
    expect(summary).toMatchObject({ replaced: 2, deferred: 1 });
    expect(t.fetcher.calls).toEqual([HTML_URL, `${PDF_URL}?1`]);
    expect(t.store.logs[0]).toMatchObject({ sourceId: "p2", reason: "maxPdfPerSource" });
    // PDF のチャンクは HTML の制度に足し、ページ番号を持つ
    const pdfChunk = [...t.store.chunks.values()].find((c) => c.sourceId === "p1");
    expect(pdfChunk).toMatchObject({ programId: "s1", pdfPage: 1, excerpt: "Page" });
  });

  it("制度がまだ無い PDF や、カテゴリ未設定の情報源は何も変えずに飛ばす", async () => {
    const pdf = source({ id: "p1", url: PDF_URL, format: "pdf", relatedSourceId: "s9" });
    const t = setup(
      [pdf, source({ category: null })],
      [
        [
          PDF_URL,
          { kind: "ok", status: 200, contentType: "application/pdf", body: makePdf(["x"]) },
        ],
        [HTML_URL, PAGE_V1],
      ],
    );
    const summary = await runCollection(t.deps, SETTINGS);
    expect(summary).toMatchObject({ skipped: 2, replaced: 0 });
    expect(t.store.chunks.size).toBe(0);
    expect(t.store.sources.get("p1")?.lastHash).toBeUndefined();
    expect(t.store.logs.map((l) => l.reason).sort()).toEqual([
      "category_missing",
      "program_missing",
    ]);
  });

  it("確認済みの制度の内容が変わったら要再確認にし、制度のチャンクをすべて検索対象から外す", async () => {
    const pdf = source({ id: "p1", url: PDF_URL, format: "pdf", relatedSourceId: "s1" });
    const t = setup(
      [source(), pdf],
      [
        [HTML_URL, PAGE_V1],
        [
          PDF_URL,
          { kind: "ok", status: 200, contentType: "application/pdf", body: makePdf(["x"]) },
        ],
      ],
    );
    await runCollection(t.deps, SETTINGS);
    await verify(t.store, "s1");
    const oldIds = [...t.store.chunks.keys()].filter((id) => id.startsWith("s1_"));

    t.fetcher.responses.set(HTML_URL, PAGE_V2);
    later(t.clock);
    await runCollection(t.deps, SETTINGS);
    const program = t.store.programs.get("s1");
    expect(program).toMatchObject({ verified: true, needsReview: true });
    expect([...t.store.chunks.values()].some((c) => c.searchable)).toBe(false);
    // 旧チャンクは消え、新チャンクだけが残る
    for (const id of oldIds) expect(t.store.chunks.has(id)).toBe(false);
    expect([...t.store.chunks.values()].some((c) => c.excerpt.includes("高校生"))).toBe(true);

    // 確認した内容に戻れば、確認済みのまま検索対象に戻る
    t.fetcher.responses.set(HTML_URL, PAGE_V1);
    later(t.clock);
    await runCollection(t.deps, SETTINGS);
    expect(t.store.programs.get("s1")).toMatchObject({ verified: true, needsReview: false });
    expect([...t.store.chunks.values()].every((c) => c.searchable)).toBe(true);
  });

  it("確認済みの制度の PDF が変わったときも要再確認にする", async () => {
    const pdf = source({ id: "p1", url: PDF_URL, format: "pdf", relatedSourceId: "s1" });
    const pdfOk = (text: string): FetchResult => ({
      kind: "ok",
      status: 200,
      contentType: "application/pdf",
      body: makePdf([text]),
    });
    const t = setup(
      [source(), pdf],
      [
        [HTML_URL, PAGE_V1],
        [PDF_URL, pdfOk("v1")],
      ],
    );
    await runCollection(t.deps, SETTINGS);
    await verify(t.store, "s1");
    t.fetcher.responses.set(PDF_URL, pdfOk("v2"));
    later(t.clock);
    await runCollection(t.deps, SETTINGS);
    expect(t.store.programs.get("s1")?.needsReview).toBe(true);
    expect([...t.store.chunks.values()].some((c) => c.searchable)).toBe(false);
  });

  it("埋め込みや抽出に失敗したら、旧チャンクを消さず、情報源のハッシュも更新しない", async () => {
    for (const fail of ["embed", "extract", "upsertChunks", "deleteOldChunks"] as const) {
      const t = setup([source()], [[HTML_URL, PAGE_V1]]);
      await runCollection(t.deps, SETTINGS);
      await verify(t.store, "s1");
      const oldIds = [...t.store.chunks.keys()];
      const hash = t.store.sources.get("s1")?.lastHash;

      t.fetcher.responses.set(HTML_URL, PAGE_V2);
      if (fail === "embed") t.embedder.fail = true;
      else if (fail === "extract") t.extractor.fail = true;
      else t.store.failOn.add(fail);
      later(t.clock);
      const summary = await runCollection(t.deps, SETTINGS);
      expect(summary.errors).toBe(1);
      for (const id of oldIds) expect(t.store.chunks.has(id)).toBe(true);
      expect(t.store.sources.get("s1")?.lastHash).toBe(hash);
      // 内容が変わったことは分かっているので、検索対象からは外す（安全側）
      expect([...t.store.chunks.values()].some((c) => c.searchable)).toBe(false);
      expect(t.store.logs.at(-1)).toMatchObject({ result: "error", reason: "Error" });

      // 次の実行で置き換えが完了する
      t.embedder.fail = false;
      t.extractor.fail = false;
      t.store.failOn.clear();
      later(t.clock);
      expect(await runCollection(t.deps, SETTINGS)).toMatchObject({ replaced: 1 });
      for (const id of oldIds) expect(t.store.chunks.has(id)).toBe(false);
    }
  });

  it("運営スイッチが停止なら取得を始めない。読めないときも止める", async () => {
    for (const values of [[OFF], [null]]) {
      const t = setup([source()], [[HTML_URL, PAGE_V1]]);
      t.deps.ops = new MemoryOps(values);
      const summary = await runCollection(t.deps, SETTINGS);
      expect(summary).toMatchObject({ stopped: true, fetched: 0 });
      expect(t.fetcher.calls).toEqual([]);
      expect(t.store.logs).toEqual([]);
    }
  });

  it("各取得の直前にも運営スイッチを確かめ、停止されたらそこで止める", async () => {
    const urls = ["a", "b"].map((x) => `${HTML_URL}?${x}`);
    const t = setup(
      urls.map((url, i) => source({ id: `s${i}`, url })),
      urls.map((url) => [url, PAGE_V1] as [string, FetchResult]),
    );
    // 開始時・1件目の前は稼働、2件目の前で停止
    t.deps.ops = new MemoryOps([ON, ON, OFF]);
    const summary = await runCollection(t.deps, SETTINGS);
    expect(summary).toMatchObject({ stopped: true, fetched: 1 });
    expect(t.fetcher.calls).toEqual([urls[0]]);
  });

  it("取得記録には出典URL・時刻・原因だけを入れ、本文や例外の文面を入れない", async () => {
    const t = setup([source()], [[HTML_URL, PAGE_V2]]);
    t.embedder.fail = true;
    await runCollection(t.deps, SETTINGS);
    const text = JSON.stringify(t.store.logs);
    expect(text).not.toContain("高校生");
    expect(text).not.toContain("injected");
    for (const log of t.store.logs) {
      expect(Object.keys(log).sort()).toEqual(
        Object.keys(log)
          .filter((k) => ["sourceId", "url", "at", "result", "reason", "count"].includes(k))
          .sort(),
      );
    }
  });
});
