// 回答の引用と根拠の検証（Requirement 5.2, 5.3, 5.11〜5.13, 14.4）
// LLM による判定（judgeClaims）以外の、決まった計算だけをここに置く。

const CITATION = /\[(\d+)\]/g;

/** 本文中の引用番号 [n] を、初めて現れた順に重複なく返す */
export function parseCitations(text: string): number[] {
  const seen = new Set<number>();
  for (const match of text.matchAll(CITATION)) seen.add(Number(match[1]));
  return [...seen];
}

/**
 * 取得したチャンクの件数 n に対して、範囲外（1〜n でない）の引用番号を列挙する。
 * 本文は変えない。無効な番号を黙って削除しない。
 */
export function validateCitations(text: string, n: number): number[] {
  return parseCitations(text).filter((c) => !(Number.isSafeInteger(c) && c >= 1 && c <= n));
}

export type Claim = { text: string; citations: number[] };

// 引用のない文のうち、事実を述べていないとみなすもの（見出し・挨拶・前置き）
const NON_CLAIM: readonly RegExp[] = [
  /^#{1,6}\s/, // Markdown の見出し
  /^【[^】]*】$/, // 【見出し】
  /^\*\*[^*]+\*\*$/, // 太字だけの行
  /[：:]$/, // 「必要なもの：」のような導入
  /^(?:ご質問|お問い合わせ|ご相談)(?:いただき)?、?ありがとうございます/,
  /^こんにちは/,
  /(?:について|を)(?:ご)?(?:説明|案内|紹介|回答)(?:いた)?します$/,
  /^(?:以下|次)の(?:とおり|通り)です$/,
  // 結びの「窓口で確認してください」。数字（電話番号・金額・日付）を含むものは事実として残す
  /^(?=[^0-9０-９]{1,60}$)(?=.*窓口)(?=.*確認).*ください$/,
];

const OPEN_BRACKETS = "（(「『【";
const CLOSE_BRACKETS = "）)」』】";

/** 改行と、括弧の外にある句点で文に分ける（「（〜除きます。〜）[5]」を1文に保つ） */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let depth = 0;
  for (const ch of text) {
    if (ch === "\n" || (ch === "。" && depth === 0)) {
      out.push(current);
      current = "";
      if (ch === "\n") depth = 0;
      continue;
    }
    if (OPEN_BRACKETS.includes(ch)) depth += 1;
    else if (CLOSE_BRACKETS.includes(ch)) depth = Math.max(0, depth - 1);
    current += ch;
  }
  out.push(current);
  return out;
}

/**
 * 回答を句点（。）と改行で文に分け、事実を述べる文ごとに引用番号を取り出す。
 * - 「〜です。[1]」のように句点の後に付いた引用は、その文に含める
 * - 括弧の中の句点では分けない（引用は括弧の後に付くため、分けると前半が引用なしになる）
 * - 引用のある文は、見た目が見出しなどでも必ず主張として残す（検証から漏らさない）
 */
export function splitClaims(text: string): Claim[] {
  // 句点の直後の引用を1つずつ句点の前へ移す（引用が無くなるまで繰り返す）
  const trailing = /。([^\S\n]*\[\d+\])/g;
  let moved = text;
  while (moved.replace(trailing, "$1。") !== moved) moved = moved.replace(trailing, "$1。");
  const claims: Claim[] = [];
  for (const raw of splitSentences(moved)) {
    const sentence = raw.trim();
    if (sentence === "") continue;
    const citations = parseCitations(sentence);
    if (citations.length === 0 && NON_CLAIM.some((re) => re.test(sentence))) continue;
    claims.push({ text: sentence, citations });
  }
  return claims;
}

export type GroundingInput =
  // 引用されたチャンクの本文と対にした主張。LLM の判定に送る
  | { kind: "cited"; claim: string; citations: number[]; excerpts: string[] }
  // 引用がない（または範囲内の引用がない）主張。LLM に送らず不合格とする
  | { kind: "uncited"; claim: string };

/**
 * 主張ごとに、引用番号 [n] を取得したチャンク（n 番目 = chunks[n-1]）の本文に対応づける。
 */
export function buildGroundingInputs(
  claims: readonly Claim[],
  chunks: readonly { excerpt: string }[],
): GroundingInput[] {
  return claims.map((claim): GroundingInput => {
    const inRange = claim.citations.filter((c) => c >= 1 && c <= chunks.length);
    if (inRange.length === 0) return { kind: "uncited", claim: claim.text };
    return {
      kind: "cited",
      claim: claim.text,
      citations: inRange,
      excerpts: inRange.map((c) => chunks.at(c - 1)?.excerpt ?? ""),
    };
  });
}

export type ClaimVerdict = "supported" | "unsupported" | "uncited";

export type GroundingResult = {
  passed: boolean;
  supported: number;
  total: number;
  // supported / total。主張が無いときは 0
  groundedRate: number;
};

/**
 * 主張ごとの判定から合否を求める。すべて supported のときだけ合格。
 * 主張が1つもない回答は、根拠を確かめられないので不合格にする。
 */
export function aggregateGrounding(verdicts: readonly ClaimVerdict[]): GroundingResult {
  const total = verdicts.length;
  const supported = verdicts.filter((v) => v === "supported").length;
  return {
    passed: total > 0 && supported === total,
    supported,
    total,
    groundedRate: total === 0 ? 0 : supported / total,
  };
}

// 再生成は、引用の無効と根拠の不合格を合わせて合計1回まで（Requirement 5.13）
export const MAX_REGENERATIONS = 1;

export type ChatAction = "accept" | "regenerate" | "fallback";

export type ChatCheck = {
  citationsValid: boolean;
  groundingPassed: boolean;
  // これまでに再生成した回数
  regenerations: number;
};

/** 検証結果と再生成済みの回数から、次に行うことを決める */
export function nextChatAction(check: ChatCheck): ChatAction {
  if (check.citationsValid && check.groundingPassed) return "accept";
  return check.regenerations < MAX_REGENERATIONS ? "regenerate" : "fallback";
}

export const FALLBACK_MESSAGE = "根拠を確認できませんでした";

export type FallbackSource = { n: number; title: string; url: string; fetchedAt?: string };

export type FallbackView = {
  message: typeof FALLBACK_MESSAGE;
  sources: FallbackSource[];
  contact: string;
};

/**
 * fallback の表示モデル。回答本文は受け取らず、事実として表示しない。
 * 取得した出典の一覧と、ユーザーの市区町村の問い合わせ窓口を返す。
 */
export function buildFallbackView(
  sources: readonly FallbackSource[],
  contact: string,
): FallbackView {
  return { message: FALLBACK_MESSAGE, sources: sources.map((s) => ({ ...s })), contact };
}
