// 収集の実行ループ（Requirement 3.1〜3.8, 3.11, 3.12, 3.15, 13.11, 13.13）

import {
  chunkSource,
  decideSourceAction,
  isDue,
  l2Normalize,
  normalizeExtraction,
  planFetch,
  type EmbeddingTarget,
  type SourceDoc,
  type SourceSection,
} from "@hachioji-gov/shared";
import type {
  ChunkToWrite,
  Clock,
  CollectorStore,
  Embedder,
  Fetcher,
  FetchLogResult,
  FetchResult,
  OpsConfigStore,
  ProgramExtractor,
  ProgramRecord,
} from "./ports.js";
import { extractSections, hashSections } from "./text.js";

export type CollectorDeps = {
  store: CollectorStore;
  fetcher: Fetcher;
  embedder: Embedder;
  extractor: ProgramExtractor;
  clock: Clock;
  ops: OpsConfigStore;
  // 再試行の待ち時間（テストでは待たない）
  sleep?: (ms: number) => Promise<void>;
};

export type CollectorSettings = {
  maxPagesPerRun: number;
  maxPdfPerSource: number;
  maxRetries: number;
  timeoutSec: number;
  embedding: EmbeddingTarget;
};

export type RunSummary = {
  // 運営スイッチで止まったか
  stopped: boolean;
  fetched: number;
  replaced: number;
  unchanged: number;
  notFound: number;
  excluded: number;
  skipped: number;
  errors: number;
  deferred: number;
};

const RETRY_BASE_MS = 1000;
// 構造化抽出に渡す本文の上限（文字数）
export const EXTRACT_MAX_CHARS = 20000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// 例外の名前だけを原因にする（メッセージには取得した本文が入りうる）
function errorName(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "UnknownError";
}

async function collectionEnabled(ops: OpsConfigStore): Promise<boolean> {
  try {
    return (await ops.read()).collectionEnabled;
  } catch {
    // 読めないときは止める（安全側）
    return false;
  }
}

async function fetchWithRetry(
  deps: CollectorDeps,
  url: string,
  settings: CollectorSettings,
): Promise<FetchResult> {
  const sleep = deps.sleep ?? defaultSleep;
  let result: FetchResult = { kind: "error", reason: "not_attempted", retryable: false };
  for (let attempt = 0; attempt <= settings.maxRetries; attempt++) {
    if (attempt > 0) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    try {
      result = await deps.fetcher.fetch(url, { timeoutMs: settings.timeoutSec * 1000 });
    } catch (e) {
      result = { kind: "error", reason: errorName(e), retryable: true };
    }
    if (result.kind !== "error" || !result.retryable) return result;
  }
  return result;
}

function emptySummary(): RunSummary {
  return {
    stopped: false,
    fetched: 0,
    replaced: 0,
    unchanged: 0,
    notFound: 0,
    excluded: 0,
    skipped: 0,
    errors: 0,
    deferred: 0,
  };
}

// 構造化抽出に渡す本文。見出しも含める
function plainText(sections: readonly SourceSection[]): string {
  return sections
    .map((s) => (s.heading === undefined ? s.text : `${s.heading}\n${s.text}`))
    .join("\n\n")
    .slice(0, EXTRACT_MAX_CHARS);
}

/** HTML の情報源から、制度を新しい内容で作る。確認の状態は引き継ぐ */
function buildProgram(
  source: SourceDoc,
  category: NonNullable<SourceDoc["category"]>,
  existing: ProgramRecord | null,
  extracted: unknown,
  hash: string,
  at: string,
): ProgramRecord {
  const info = normalizeExtraction(extracted);
  const verified = existing?.verified ?? false;
  const program: ProgramRecord = {
    id: source.id,
    sourceId: source.id,
    name: info.name ?? source.title ?? source.url,
    level: source.level,
    municipalityCode: source.municipalityCode,
    category,
    ageBands: source.ageBands.length > 0 ? [...source.ageBands] : ["unknown"],
    summary: info.summary,
    eligibility: info.eligibility,
    procedure: info.procedure,
    requiredDocs: info.requiredDocs,
    deadline: info.deadline,
    contact: info.contact,
    sourceName: info.sourceName,
    sourceUrl: source.url,
    fetchedAt: at,
    verified,
    contentHash: hash,
    // 確認済みの内容から変わったら再確認が必要（applyContentChange と同じ規則）
    needsReview:
      existing?.verifiedContentHash !== undefined && existing.verifiedContentHash !== hash,
    status: "active",
    updatedAt: at,
  };
  if (existing?.verifiedAt !== undefined) program.verifiedAt = existing.verifiedAt;
  if (existing?.verifiedBy !== undefined) program.verifiedBy = existing.verifiedBy;
  if (existing?.verifiedContentHash !== undefined) {
    program.verifiedContentHash = existing.verifiedContentHash;
  }
  return program;
}

type Outcome = { result: FetchLogResult; reason?: string; count?: number };

async function processSource(
  deps: CollectorDeps,
  settings: CollectorSettings,
  source: SourceDoc,
): Promise<Outcome> {
  const { store } = deps;
  const at = deps.clock.now().toISOString();
  const res = await fetchWithRetry(deps, source.url, settings);

  if (res.kind === "error") return { result: "error", reason: res.reason };

  if (res.kind === "not_found") {
    const decision = decideSourceAction(source.lastHash ?? null, null, source.missCount);
    if (decision.action === "exclude") {
      await store.markExcluded(source.id);
      await store.updateSource(source.id, { missCount: decision.missCount, lastFetchedAt: at });
      return { result: "excluded", reason: `http_${res.status}` };
    }
    // まだ除外しない。チャンクは保持する
    await store.updateSource(source.id, { missCount: decision.missCount, lastFetchedAt: at });
    return { result: "not_found", reason: `http_${res.status}` };
  }

  const sections = await extractSections(source.format, res.body, res.contentType);
  if (sections.length === 0) return { result: "error", reason: "empty_content" };
  const hash = hashSections(sections);
  const decision = decideSourceAction(source.lastHash ?? null, hash, source.missCount);
  if (decision.action === "skip") {
    await store.updateSource(source.id, { lastFetchedAt: at, missCount: 0 });
    return { result: "unchanged" };
  }

  // ここから置換。前提がそろわないものは何も変えずに飛ばす
  const category = source.category;
  if (category === null) return { result: "skipped", reason: "category_missing" };
  const programId = source.format === "pdf" ? source.relatedSourceId : source.id;
  if (programId === null) return { result: "skipped", reason: "related_source_missing" };
  const existing = await store.getProgram(programId);
  if (source.format === "pdf" && existing === null) {
    return { result: "skipped", reason: "program_missing" };
  }

  // ① 確認済みの制度の内容が変わったら、先に検索対象から外す
  const needsReview =
    existing !== null &&
    existing.verified &&
    (source.format === "pdf" || existing.verifiedContentHash !== hash);
  await store.beginReplace(source.id, programId, needsReview, at);

  // 構造化抽出（HTML だけ。表示専用）→ 原文のチャンク化 → 埋め込み
  const program =
    source.format === "html"
      ? buildProgram(
          source,
          category,
          existing,
          await deps.extractor.extractProgram(plainText(sections)),
          hash,
          at,
        )
      : null;
  const drafts = chunkSource(sections, {
    programId,
    sourceId: source.id,
    sourceUrl: source.url,
    fetchedAt: at,
    contentHash: hash,
    municipalityCode: source.municipalityCode,
    level: source.level,
    category,
    ageBands: source.ageBands,
  });
  const target = settings.embedding;
  const vectors = await deps.embedder.embed(
    drafts.map((c) => (c.heading === undefined ? c.excerpt : `${c.heading}\n${c.excerpt}`)),
    "RETRIEVAL_DOCUMENT",
    target,
  );
  if (vectors.length !== drafts.length) throw new RangeError("embedding count mismatch");
  const chunks: ChunkToWrite[] = drafts.map((c, i) => {
    const v = vectors.at(i) ?? [];
    if (v.length !== target.dimensions) throw new RangeError("embedding dimension mismatch");
    return {
      ...c,
      embedding: l2Normalize(v),
      embeddingMeta: Object.fromEntries([
        [target.version, { model: target.model, dimensions: target.dimensions, createdAt: at }],
      ]),
    };
  });

  // ② 新チャンクを searchable=false で書き込み ③ 旧チャンクを削除
  await store.upsertChunks(source.id, chunks, target);
  if (program !== null) await store.saveProgram(program);
  await store.updateSource(source.id, { lastHash: hash, lastFetchedAt: at, missCount: 0 });

  // 確認済みの内容に戻ったときは、確認済みのまま検索対象に戻す
  const current = program ?? (await store.getProgram(programId));
  if (current !== null && current.verified && !current.needsReview && current.status === "active") {
    await store.setSearchable(programId, true);
  }
  return { result: "replaced", count: chunks.length };
}

/** 取得期限が来た情報源を集める。1つの情報源の失敗で他を止めない */
export async function runCollection(
  deps: CollectorDeps,
  settings: CollectorSettings,
): Promise<RunSummary> {
  const summary = emptySummary();
  const { store } = deps;
  if (!(await collectionEnabled(deps.ops))) return { ...summary, stopped: true };

  const now = deps.clock.now();
  // 制度を作る HTML を、それに足す PDF より先に処理する
  const due = (await store.listSources())
    .filter((s) => isDue(s, now))
    .sort((a, b) => Number(a.format === "pdf") - Number(b.format === "pdf"));
  const plan = planFetch(
    due.map((source) => ({
      url: source.url,
      format: source.format,
      groupId: source.relatedSourceId ?? source.id,
      source,
    })),
    settings,
  );

  const log = async (source: SourceDoc, outcome: Outcome): Promise<void> => {
    try {
      await store.addFetchLog({
        sourceId: source.id,
        url: source.url,
        at: deps.clock.now().toISOString(),
        ...outcome,
      });
    } catch {
      // 記録の失敗で収集を止めない
    }
  };

  for (const { target, reason } of plan.deferred) {
    summary.deferred += 1;
    await log(target.source, { result: "deferred", reason });
  }

  for (const { source } of plan.selected) {
    if (!(await collectionEnabled(deps.ops))) {
      summary.stopped = true;
      break;
    }
    let outcome: Outcome;
    try {
      outcome = await processSource(deps, settings, source);
    } catch (e) {
      outcome = { result: "error", reason: errorName(e) };
    }
    summary.fetched += 1;
    switch (outcome.result) {
      case "replaced":
        summary.replaced += 1;
        break;
      case "unchanged":
        summary.unchanged += 1;
        break;
      case "not_found":
        summary.notFound += 1;
        break;
      case "excluded":
        summary.excluded += 1;
        break;
      case "skipped":
        summary.skipped += 1;
        break;
      default:
        summary.errors += 1;
    }
    await log(source, outcome);
  }
  return summary;
}
