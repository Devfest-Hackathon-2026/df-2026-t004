// 運営者の操作（Requirement 3.13〜3.16, 13.4, 13.5, 13.11, 13.14）
// 判定は shared の純粋関数（applyVerification・canVerify・validateSourceRegistration・
// planReembed・canCutover）を使い、ここでは入出力と書き込みの順序だけを決める。

import {
  applyVerification,
  canCutover,
  canVerify,
  isSearchable,
  planReembed,
  todayJst,
  validateSourceRegistration,
  type EmbeddingTarget,
  type OpsSwitch,
  type Program,
  type SourceDoc,
} from "@hachioji-gov/shared";
import type { Embedder } from "@hachioji-gov/collector";
import { VERSION_PATTERN, type AdminAuth, type AdminStore, type StoredVector } from "./ports.js";

export type EmbeddingConfig = { model: string; dimensions: number; version: string };

export type CommandContext = {
  store: AdminStore;
  auth: AdminAuth;
  /** 再生成のときだけ作る（Vertex AI の初期化を他のコマンドで行わない） */
  embedder: () => Embedder;
  out: (line: string) => void;
  err: (line: string) => void;
  /** 対話で1行読む */
  prompt: (question: string) => Promise<string>;
  now: () => Date;
  readFile: (path: string) => Promise<string>;
  project: string;
  /** --operator で指定した運営者の uid */
  operator: string | null;
  embedding: EmbeddingConfig;
  defaultIntervalHours: number;
};

/** 失敗の終了コード。使い方の誤りは 2 */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

// 1回の埋め込み呼び出しで送る件数
export const REEMBED_BATCH = 20;
// ノルムが 1 からこれ以上ずれていたら不正とみなす
export const NORM_TOLERANCE = 1e-3;
// 確認の画面に出す原文抜粋の最大件数
export const MAX_EXCERPTS_SHOWN = 50;
const UPDATED_BY_FALLBACK = "admin-cli";

function updatedBy(ctx: CommandContext): string {
  return ctx.operator ?? UPDATED_BY_FALLBACK;
}

/**
 * 運営者の権限を確かめる（Requirement 3.16）。--operator の uid のカスタムクレームを
 * Firebase Auth から読み、canVerify が真のときだけ通す。
 */
export async function requireAdmin(ctx: CommandContext): Promise<string | null> {
  if (ctx.operator === null) {
    ctx.err("この操作には --operator <uid>（admin クレームを持つ運営者）の指定が必要です。");
    return null;
  }
  const claims = await ctx.auth.getClaims(ctx.operator);
  if (!canVerify(claims)) {
    ctx.err(`運営者 ${ctx.operator} は admin クレームを持っていないため、操作を拒否しました。`);
    return null;
  }
  return ctx.operator;
}

function showProgram(ctx: CommandContext, p: Program): void {
  ctx.out(`制度: ${p.name}（${p.id}）`);
  ctx.out(`  自治体コード: ${p.municipalityCode} ／ レベル: ${p.level} ／ カテゴリ: ${p.category}`);
  ctx.out(`  出典: ${p.sourceUrl ?? "（なし）"} ／ 取得日: ${p.fetchedAt ?? "（なし）"}`);
  ctx.out(`  内容のハッシュ: ${p.contentHash}`);
  ctx.out(
    `  状態: verified=${p.verified} needsReview=${p.needsReview} status=${p.status}` +
      (p.verifiedContentHash === undefined ? "" : ` 確認時のハッシュ=${p.verifiedContentHash}`),
  );
  ctx.out(`  対象（抽出）: ${p.eligibility ?? "（読み取れず）"}`);
  ctx.out(`  締切（抽出）: ${p.deadline ?? "（読み取れず）"}`);
  ctx.out(`  必要書類（抽出）: ${p.requiredDocs?.join("、") ?? "（読み取れず）"}`);
}

/**
 * verify <programId>（Requirement 3.13〜3.15）
 * ①ハッシュと原文を表示 → ②対話で確認 → ③applyVerification を書く → ④チャンクを searchable=true。
 * ④で失敗しても、再実行すれば完了する（冪等）。
 */
export async function verifyProgram(ctx: CommandContext, programId: string): Promise<number> {
  const operator = await requireAdmin(ctx);
  if (operator === null) return EXIT_FAILED;
  const program = await ctx.store.getProgram(programId);
  if (program === null) {
    ctx.err(`制度 ${programId} が見つかりません。`);
    return EXIT_FAILED;
  }
  if (program.status !== "active") {
    ctx.err(`制度 ${programId} は除外されているため、確認済みにできません。`);
    return EXIT_FAILED;
  }
  const chunks = await ctx.store.listProgramChunks(programId);
  if (chunks.length === 0) {
    ctx.err(`制度 ${programId} の原文抜粋がないため、確認できません。収集の後に実行してください。`);
    return EXIT_FAILED;
  }

  showProgram(ctx, program);
  ctx.out(`原文抜粋（${chunks.length}件）:`);
  for (const c of chunks.slice(0, MAX_EXCERPTS_SHOWN)) {
    const where = [c.heading, c.pdfPage === undefined ? undefined : `p.${c.pdfPage}`]
      .filter((x) => x !== undefined)
      .join(" ");
    ctx.out(`--- ${c.id}${where === "" ? "" : `（${where}）`} ${c.sourceUrl}`);
    ctx.out(c.excerpt);
  }
  if (chunks.length > MAX_EXCERPTS_SHOWN) {
    ctx.out(`（ほか ${chunks.length - MAX_EXCERPTS_SHOWN} 件は省略）`);
  }

  const answer = await ctx.prompt(
    "対象・締切・必要書類を原文と照合しましたか？ 確認済みにするには yes と入力してください: ",
  );
  if (answer.trim() !== "yes") {
    ctx.out("中止しました。変更はありません。");
    return EXIT_FAILED;
  }

  const now = ctx.now();
  const verified = applyVerification(program, program.contentHash, todayJst(now), operator);
  const saved = await ctx.store.saveVerification(
    programId,
    {
      verified: verified.verified,
      verifiedAt: verified.verifiedAt,
      verifiedBy: verified.verifiedBy,
      verifiedContentHash: verified.verifiedContentHash,
      needsReview: verified.needsReview,
      updatedAt: now.toISOString(),
    },
    { contentHash: program.contentHash, updatedAt: program.updatedAt },
  );
  if (!saved) {
    ctx.err("表示した後に制度の内容が更新されました。もう一度 verify を実行してください。");
    return EXIT_FAILED;
  }
  await ctx.store.setChunksSearchable(programId, true);

  // 書き込みの間に収集が内容の変更を検知していた場合は、検索対象に戻さない（安全側）
  const after = await ctx.store.getProgram(programId);
  if (after === null || !isSearchable(after)) {
    await ctx.store.setChunksSearchable(programId, false);
    ctx.err("確認の途中で制度が更新されたため、検索対象にしませんでした。再実行してください。");
    return EXIT_FAILED;
  }
  ctx.out(
    `確認済みにしました（verifiedAt=${verified.verifiedAt}、チャンク ${chunks.length} 件）。`,
  );
  return EXIT_OK;
}

/** unverify <programId>。先にチャンクを検索対象から外し、次に確認状態を消す（途中で失敗しても安全側） */
export async function unverifyProgram(ctx: CommandContext, programId: string): Promise<number> {
  const operator = await requireAdmin(ctx);
  if (operator === null) return EXIT_FAILED;
  const program = await ctx.store.getProgram(programId);
  if (program === null) {
    ctx.err(`制度 ${programId} が見つかりません。`);
    return EXIT_FAILED;
  }
  await ctx.store.setChunksSearchable(programId, false);
  await ctx.store.saveVerification(
    programId,
    {
      verified: false,
      verifiedAt: undefined,
      verifiedBy: undefined,
      verifiedContentHash: undefined,
      needsReview: false,
      updatedAt: ctx.now().toISOString(),
    },
    null,
  );
  ctx.out(`確認を取り消しました。制度 ${programId} は検索・表示の対象外です。`);
  return EXIT_OK;
}

export type OpsTarget = "ai" | "collection" | "all";

/** ops stop|start [ai|collection]（Requirement 13.11） */
export async function setOps(
  ctx: CommandContext,
  action: "stop" | "start",
  target: OpsTarget,
): Promise<number> {
  const enabled = action === "start";
  const change: Partial<OpsSwitch> = {};
  if (target !== "collection") change.aiEnabled = enabled;
  if (target !== "ai") change.collectionEnabled = enabled;
  const value = await ctx.store.updateOps(change, updatedBy(ctx), ctx.now().toISOString());
  ctx.out(
    `運営スイッチ: AI=${value.aiEnabled ? "稼働" : "停止"} ／ 収集=${
      value.collectionEnabled ? "稼働" : "停止"
    }（API には10秒以内に反映されます）`,
  );
  return EXIT_OK;
}

/**
 * grant-admin <uid>（Requirement 3.16）。対象のプロジェクト ID を入力させてから付与する。
 */
export async function grantAdmin(ctx: CommandContext, uid: string): Promise<number> {
  const answer = await ctx.prompt(
    `プロジェクト ${ctx.project} のユーザー ${uid} に admin クレームを付与します。` +
      "続けるにはプロジェクト ID を入力してください: ",
  );
  if (answer.trim() !== ctx.project) {
    ctx.out("プロジェクト ID が一致しないため中止しました。変更はありません。");
    return EXIT_FAILED;
  }
  if (!(await ctx.auth.grantAdmin(uid))) {
    ctx.err(`ユーザー ${uid} が見つかりません。`);
    return EXIT_FAILED;
  }
  ctx.out(
    `ユーザー ${uid} に admin クレームを付与しました。反映にはトークンの再取得（再ログイン）が必要です。`,
  );
  return EXIT_OK;
}

function describeErrors(errors: readonly { field: string; kind: "missing" | "invalid" }[]): string {
  return errors.map((e) => `${e.field}（${e.kind === "missing" ? "欠落" : "無効"}）`).join("、");
}

function toSourceDoc(value: Omit<SourceDoc, "status" | "missCount">): SourceDoc {
  return { ...value, status: "active", missCount: 0 };
}

/** sources add（Requirement 13.4, 13.5）。失敗時は既存の登録を変えずに、欠落・無効な項目名を出す */
export async function addSource(ctx: CommandContext, input: unknown): Promise<number> {
  const result = validateSourceRegistration(input, ctx.defaultIntervalHours);
  if (!result.ok) {
    ctx.err(`登録を拒否しました: ${describeErrors(result.errors)}`);
    return EXIT_FAILED;
  }
  const existing = await ctx.store.listSources();
  const sameUrl = existing.find((s) => s.url === result.value.url);
  if (sameUrl !== undefined) {
    ctx.err(`この URL は情報源 ${sameUrl.id} として登録済みです。変更はありません。`);
    return EXIT_FAILED;
  }
  if ((await ctx.store.createSource(toSourceDoc(result.value))) === "exists") {
    ctx.err(`ID ${result.value.id} は登録済みです。変更はありません。`);
    return EXIT_FAILED;
  }
  ctx.out(
    `情報源 ${result.value.id} を登録しました（次回の定期実行から収集します）: ${result.value.url}`,
  );
  return EXIT_OK;
}

export type ImportReport = {
  created: string[];
  skipped: string[];
  failed: { row: number; id: string | null; reason: string }[];
};

/**
 * sources import <file>（Requirement 3.1, 13.4, 13.5）
 * 各行を検証し、登録済みの URL は飛ばす（冪等）。失敗した行と理由を一覧で出す。既存の登録は変えない。
 */
export async function importSources(
  ctx: CommandContext,
  path: string,
  dryRun: boolean,
): Promise<number> {
  let rows: unknown;
  try {
    rows = JSON.parse(await ctx.readFile(path)) as unknown;
  } catch {
    ctx.err(`${path} を JSON として読めません。`);
    return EXIT_FAILED;
  }
  if (!Array.isArray(rows)) {
    ctx.err(`${path} は情報源の配列ではありません。`);
    return EXIT_FAILED;
  }

  const existing = await ctx.store.listSources();
  const urls = new Map(existing.map((s) => [s.url, s.id] as const));
  const ids = new Set(existing.map((s) => s.id));
  const report: ImportReport = { created: [], skipped: [], failed: [] };

  for (const [index, row] of rows.entries()) {
    const rowNo = index + 1;
    const result = validateSourceRegistration(row, ctx.defaultIntervalHours);
    if (!result.ok) {
      const id = (row as { id?: unknown } | null)?.id;
      report.failed.push({
        row: rowNo,
        id: typeof id === "string" ? id : null,
        reason: describeErrors(result.errors),
      });
      continue;
    }
    const { value } = result;
    if (urls.has(value.url)) {
      report.skipped.push(value.id);
      continue;
    }
    if (ids.has(value.id)) {
      report.failed.push({ row: rowNo, id: value.id, reason: "ID が別の URL で登録済み" });
      continue;
    }
    if (!dryRun && (await ctx.store.createSource(toSourceDoc(value))) === "exists") {
      report.failed.push({ row: rowNo, id: value.id, reason: "ID が登録済み" });
      continue;
    }
    urls.set(value.url, value.id);
    ids.add(value.id);
    report.created.push(value.id);
  }

  ctx.out(
    `${dryRun ? "（試行のみ・書き込みなし）" : ""}登録 ${report.created.length} 件 ／ ` +
      `登録済みのため省略 ${report.skipped.length} 件 ／ 失敗 ${report.failed.length} 件`,
  );
  for (const f of report.failed) {
    ctx.err(`  ${f.row}行目${f.id === null ? "" : `（${f.id}）`}: ${f.reason}`);
  }
  return report.failed.length === 0 ? EXIT_OK : EXIT_FAILED;
}

function targetFor(ctx: CommandContext, version: string): EmbeddingTarget {
  return { model: ctx.embedding.model, dimensions: ctx.embedding.dimensions, version };
}

function checkVersion(ctx: CommandContext, version: string): boolean {
  if (VERSION_PATTERN.test(version)) return true;
  ctx.err(`版の名前が不正です: ${version}（英数字・_・- の40文字以内）`);
  return false;
}

/**
 * reembed --to <version>（Requirement 13.13, 13.14）
 * planReembed で選んだチャンクを、原文抜粋から作り直す。検索に使う版は変えないため、
 * 再生成の間も既存の版で検索できる。途中で止まっても、再実行で残りだけを処理する。
 */
export async function reembed(ctx: CommandContext, version: string): Promise<number> {
  if (!checkVersion(ctx, version)) return EXIT_USAGE;
  const ops = await ctx.store.readOps();
  if (ops === null || ops.collectionEnabled) {
    ctx.err("収集が停止していません。先に `ops stop collection` を実行してください。");
    return EXIT_FAILED;
  }
  if ((await ctx.store.getSearchVersion()) === version) {
    ctx.err(`版 ${version} は検索に使用中のため、書き込めません。新しい版を指定してください。`);
    return EXIT_FAILED;
  }
  const target = targetFor(ctx, version);
  const plan = planReembed(await ctx.store.listChunksForReembed(), target);
  ctx.out(
    `再生成の対象: ${plan.length} 件（版 ${version}、${target.model}、${target.dimensions}次元）`,
  );
  if (plan.length === 0) return EXIT_OK;

  const embedder = ctx.embedder();
  let written = 0;
  let missing = 0;
  for (let i = 0; i < plan.length; i += REEMBED_BATCH) {
    const batch = plan.slice(i, i + REEMBED_BATCH);
    const vectors = await embedder.embed(
      batch.map((c) => c.excerpt),
      "RETRIEVAL_DOCUMENT",
      target,
    );
    if (vectors.length !== batch.length) throw new RangeError("embedding count mismatch");
    const createdAt = ctx.now().toISOString();
    for (const [j, chunk] of batch.entries()) {
      const vector = vectors.at(j);
      if (vector === undefined || vector.length !== target.dimensions) {
        throw new RangeError("embedding dimension mismatch");
      }
      const ok = await ctx.store.writeEmbedding(chunk.id, version, vector, {
        model: target.model,
        dimensions: target.dimensions,
        createdAt,
      });
      if (ok) written += 1;
      else missing += 1;
    }
    ctx.out(`  ${Math.min(i + REEMBED_BATCH, plan.length)} / ${plan.length}`);
  }
  ctx.out(
    `再生成しました: ${written} 件` + (missing > 0 ? `（削除済みのため省略 ${missing} 件）` : ""),
  );
  return EXIT_OK;
}

/** 検索対象のチャンクのベクトルを検査する。問題の一覧を返す */
export function inspectVectors(
  vectors: readonly StoredVector[],
  target: EmbeddingTarget,
): string[] {
  const problems: string[] = [];
  for (const v of vectors) {
    if (!v.searchable) continue;
    if (v.vector === undefined) {
      problems.push(`${v.id}: 版 ${target.version} のベクトルがありません`);
      continue;
    }
    if (v.vector.length !== target.dimensions) {
      problems.push(`${v.id}: 次元が ${v.vector.length}（設定は ${target.dimensions}）`);
      continue;
    }
    const norm = Math.hypot(...v.vector);
    if (!Number.isFinite(norm) || Math.abs(norm - 1) > NORM_TOLERANCE) {
      problems.push(`${v.id}: ノルムが 1 ではありません（${norm}）`);
      continue;
    }
    if (
      v.meta === undefined ||
      v.meta.model !== target.model ||
      v.meta.dimensions !== target.dimensions
    ) {
      problems.push(`${v.id}: embeddingMeta.${target.version} が設定と一致しません`);
    }
  }
  return problems;
}

const MAX_PROBLEMS_SHOWN = 20;

function reportProblems(ctx: CommandContext, problems: readonly string[]): void {
  for (const p of problems.slice(0, MAX_PROBLEMS_SHOWN)) ctx.err(`  ${p}`);
  if (problems.length > MAX_PROBLEMS_SHOWN) {
    ctx.err(`  （ほか ${problems.length - MAX_PROBLEMS_SHOWN} 件）`);
  }
}

/** reembed --verify --to <version>: ベクトルの有無・次元・ノルムを検査する */
export async function verifyEmbeddings(ctx: CommandContext, version: string): Promise<number> {
  if (!checkVersion(ctx, version)) return EXIT_USAGE;
  const vectors = await ctx.store.listVectors(version);
  const problems = inspectVectors(vectors, targetFor(ctx, version));
  const searchable = vectors.filter((v) => v.searchable).length;
  if (problems.length > 0) {
    ctx.err(
      `検証に失敗しました: 検索対象 ${searchable} 件のうち ${problems.length} 件に問題があります。`,
    );
    reportProblems(ctx, problems);
    return EXIT_FAILED;
  }
  ctx.out(`検証に成功しました: 検索対象 ${searchable} 件すべてに版 ${version} があります。`);
  return EXIT_OK;
}

/** reembed --cleanup --version <version>: 検索に使っていない版を削除する */
export async function cleanupEmbeddings(ctx: CommandContext, version: string): Promise<number> {
  if (!checkVersion(ctx, version)) return EXIT_USAGE;
  // config/embedding が無いとき、API は設定の版で検索する
  const searching = (await ctx.store.getSearchVersion()) ?? ctx.embedding.version;
  if (version === searching) {
    ctx.err(`版 ${version} は検索に使用中のため、削除できません。`);
    return EXIT_FAILED;
  }
  if (version === ctx.embedding.version) {
    ctx.err(`版 ${version} は設定（embedding.version）の版のため、削除できません。`);
    return EXIT_FAILED;
  }
  const count = await ctx.store.removeEmbedding(version);
  ctx.out(`版 ${version} の埋め込みを ${count} 件のチャンクから削除しました。`);
  return EXIT_OK;
}

/**
 * embedding set-search-version <version>（Requirement 13.14）
 * canCutover が偽（検索対象のチャンクに目標の版がそろっていない）なら拒否する。
 */
export async function setSearchVersion(ctx: CommandContext, version: string): Promise<number> {
  if (!checkVersion(ctx, version)) return EXIT_USAGE;
  const target = targetFor(ctx, version);
  const chunks = await ctx.store.listChunksForReembed();
  if (!canCutover(chunks, target)) {
    const lacking = planReembed(
      chunks.filter((c) => c.searchable),
      target,
    ).length;
    ctx.err(
      `切り替えを拒否しました: 検索対象のチャンクのうち ${lacking} 件に版 ${version}` +
        `（${target.model}、${target.dimensions}次元）がありません。先に reembed --to ${version} を実行してください。`,
    );
    return EXIT_FAILED;
  }
  const problems = inspectVectors(await ctx.store.listVectors(version), target);
  if (problems.length > 0) {
    ctx.err(`切り替えを拒否しました: ${problems.length} 件のベクトルに問題があります。`);
    reportProblems(ctx, problems);
    return EXIT_FAILED;
  }
  await ctx.store.setSearchVersion(version, updatedBy(ctx), ctx.now().toISOString());
  ctx.out(`検索に使う版を ${version} に切り替えました。`);
  if (version !== ctx.embedding.version) {
    ctx.out(
      `注意: 設定の embedding.version は ${ctx.embedding.version} です。収集はその版で書き込みます。`,
    );
  }
  return EXIT_OK;
}
