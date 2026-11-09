// 評価セットの検証と評価・性能の指標（Requirement 12.8, 14.1〜14.5）

import { z } from "zod";
import { parseCitations, validateCitations } from "./citations.js";
import { SOURCE_CATEGORIES, type SourceCategory } from "./collection.js";
import { QUESTION_MAX_CHARS } from "./question.js";
import { SEARCH_TOP_K } from "./search.js";
import { isValidSourceUrl } from "./source-registration.js";

export const EVAL_MIN_QUESTIONS = 20;
export const EVAL_MIN_NO_ANSWER = 3;

const HOUSEHOLD_BANDS = [
  "pregnancy",
  "age_0_2",
  "age_3_5",
  "age_6_11",
  "age_12_14",
  "age_15_18",
] as const;

export type EvalExpected =
  | { kind: "answerable"; sourceUrls: string[]; requiredFacts: string[] }
  | { kind: "no_answer"; expectedBehavior: "fallback_with_contact" };

export type EvalQuestion = {
  id: string;
  question: string;
  category: SourceCategory;
  // 氏名等は含めない
  household?: { ageBands: (typeof HOUSEHOLD_BANDS)[number][]; municipalityCode: string };
  expected: EvalExpected;
};

export type EvalSet = { version: string; questions: EvalQuestion[] };

const text = z.string().refine((s) => s.trim() !== "", "空です");

const evalQuestionSchema = z.object({
  id: text,
  question: text.refine((s) => [...s].length <= QUESTION_MAX_CHARS, "500文字を超えています"),
  category: z.enum(SOURCE_CATEGORIES),
  household: z
    .object({
      ageBands: z.array(z.enum(HOUSEHOLD_BANDS)),
      municipalityCode: z.string().regex(/^\d{5}$/),
    })
    .optional(),
  expected: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("answerable"),
      sourceUrls: z.array(z.string().refine(isValidSourceUrl, "出典URLが不正です")).min(1),
      requiredFacts: z.array(text).min(1),
    }),
    z.object({
      kind: z.literal("no_answer"),
      expectedBehavior: z.literal("fallback_with_contact"),
    }),
  ]),
});

const evalSetSchema = z
  .object({ version: text, questions: z.array(evalQuestionSchema) })
  .superRefine((set, ctx) => {
    if (set.questions.length < EVAL_MIN_QUESTIONS) {
      ctx.addIssue({
        code: "custom",
        path: ["questions"],
        message: `質問が${set.questions.length}問です（${EVAL_MIN_QUESTIONS}問以上必要）`,
      });
    }
    const noAnswer = set.questions.filter((q) => q.expected.kind === "no_answer").length;
    if (noAnswer < EVAL_MIN_NO_ANSWER) {
      ctx.addIssue({
        code: "custom",
        path: ["questions"],
        message: `答えのない質問が${noAnswer}問です（${EVAL_MIN_NO_ANSWER}問以上必要）`,
      });
    }
    const ids = set.questions.map((q) => q.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", path: ["questions"], message: "質問の id が重複しています" });
    }
  });

export type DecodeResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function issuesToErrors(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`);
}

/**
 * 評価セットを検証する。質問は20問以上、答えのない質問（no_answer）は3問以上。
 * 答えのある質問には出典URLと含まれるべき事実が、すべての質問にカテゴリが必要。
 */
export function validateEvalSet(raw: unknown): DecodeResult<EvalSet> {
  const parsed = evalSetSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, errors: issuesToErrors(parsed.error) };
}

/** 取得した上位 k 件の出典に、期待する出典が1つでも含まれるか（URL の完全一致） */
export function retrievalHit(
  expectedUrls: readonly string[],
  retrievedUrls: readonly string[],
  k: number = SEARCH_TOP_K,
): boolean {
  const top = new Set(retrievedUrls.slice(0, Math.max(0, k)));
  return expectedUrls.some((u) => top.has(u));
}

export type RetrievalOutcome = { expected: EvalExpected; retrievedUrls: readonly string[] };

/**
 * 再現率@k。答えのある質問のうち、期待する出典が上位 k 件に含まれた割合。
 * 答えのない質問は分母に含めない。対象が無いときは null。
 */
export function recallAtK(
  outcomes: readonly RetrievalOutcome[],
  k: number = SEARCH_TOP_K,
): number | null {
  let total = 0;
  let hits = 0;
  for (const o of outcomes) {
    if (o.expected.kind !== "answerable") continue;
    total += 1;
    if (retrievalHit(o.expected.sourceUrls, o.retrievedUrls, k)) hits += 1;
  }
  return total === 0 ? null : hits / total;
}

/** 根拠範囲内率。全質問の主張を合わせた、範囲内の主張の割合。主張が無いときは null */
export function groundedRate(
  items: readonly { groundedClaims: number; totalClaims: number }[],
): number | null {
  const total = items.reduce((s, i) => s + i.totalClaims, 0);
  const grounded = items.reduce((s, i) => s + i.groundedClaims, 0);
  return total === 0 ? null : grounded / total;
}

/** 回答の引用番号のうち、取得したチャンク（1〜n）に対応するものの数 */
export function citationCounts(
  answer: string,
  n: number,
): { validCitations: number; totalCitations: number } {
  const total = parseCitations(answer).length;
  return { validCitations: total - validateCitations(answer, n).length, totalCitations: total };
}

/** 引用の有効率。全質問の引用を合わせた、取得したチャンクに対応する引用の割合。引用が無いときは null */
export function citationValidRate(
  items: readonly { validCitations: number; totalCitations: number }[],
): number | null {
  const total = items.reduce((s, i) => s + i.totalCitations, 0);
  const valid = items.reduce((s, i) => s + i.validCitations, 0);
  return total === 0 ? null : valid / total;
}

/**
 * パーセンタイル（最近傍順位法）。値を昇順に並べ、ceil(p/100 × 件数) 番目の値を返す。
 * 返す値は必ず入力のいずれかの要素。
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new RangeError("値がありません");
  if (!(p >= 0 && p <= 100)) throw new RangeError("p は 0 以上 100 以下です");
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted.at(rank - 1) as number;
}
