// 埋め込みの版管理（Requirement 13.13, 13.14）
// 再生成は原文抜粋（excerpt）から行い、検索に使う版の切り替えは全チャンクがそろってから。

export type EmbeddingTarget = { model: string; dimensions: number; version: string };

export type EmbeddingMeta = { model: string; dimensions: number; createdAt: string };

export type EmbeddedChunk = {
  searchable: boolean;
  embeddingMeta: Readonly<Record<string, EmbeddingMeta>>;
};

function metaFor(chunk: EmbeddedChunk, version: string): EmbeddingMeta | undefined {
  return Object.prototype.hasOwnProperty.call(chunk.embeddingMeta, version)
    ? (Reflect.get(chunk.embeddingMeta, version) as EmbeddingMeta)
    : undefined;
}

/** 目標の版の埋め込みが無い、またはモデル・次元が目標と異なるか */
export function needsReembed(chunk: EmbeddedChunk, target: EmbeddingTarget): boolean {
  const meta = metaFor(chunk, target.version);
  return meta === undefined || meta.model !== target.model || meta.dimensions !== target.dimensions;
}

/** 再生成するチャンクを選ぶ。順序は入力のまま */
export function planReembed<T extends EmbeddedChunk>(
  chunks: readonly T[],
  target: EmbeddingTarget,
): T[] {
  return chunks.filter((c) => needsReembed(c, target));
}

/**
 * 再生成した結果をチャンクに記録する（embeddingMeta の目標の版だけを書き換える）。
 * ベクトル本体（emb_{version}）は呼び出し側が書く。excerpt や searchable は変えない。
 */
export function applyReembed<T extends EmbeddedChunk>(
  chunk: T,
  target: EmbeddingTarget,
  createdAt: string,
): T {
  const meta: EmbeddingMeta = { model: target.model, dimensions: target.dimensions, createdAt };
  return { ...chunk, embeddingMeta: { ...chunk.embeddingMeta, [target.version]: meta } };
}

/** 検索対象のチャンクがすべて目標の版を持つときだけ、検索の版を切り替えてよい */
export function canCutover(chunks: readonly EmbeddedChunk[], target: EmbeddingTarget): boolean {
  return chunks.every((c) => !c.searchable || !needsReembed(c, target));
}
