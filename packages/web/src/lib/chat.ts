// AI 相談の回答の状態（Requirement 5.2, 5.6, 5.7, 5.9, 5.10, 5.12, 12.1〜12.3, 12.7）

export const QUESTION_MAX = 500;
export const SUGGESTIONS_MAX = 3;
export const PII_NOTE = "氏名や病歴などの個人情報は入力しないでください";
export const MEDICAL_DISCLAIMER = "診断や治療の判断は医師が行います";

export type ChatSource = {
  readonly n: number;
  readonly title: string;
  readonly url: string;
  readonly fetchedAt?: string;
};

/** POST /chat の SSE イベント（設計書の API エンドポイント） */
export type ChatEvent =
  | { readonly type: "status"; readonly status: string }
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "reset" }
  | { readonly type: "verified" }
  | { readonly type: "sources"; readonly sources: readonly ChatSource[] }
  | { readonly type: "suggestions"; readonly suggestions: readonly string[] }
  | { readonly type: "proposal"; readonly programId: string; readonly programName: string }
  | { readonly type: "fallback"; readonly sources: readonly ChatSource[]; readonly contact: string }
  | { readonly type: "error"; readonly message: string; readonly retryAt?: string };

export type AnswerStatus = "waiting" | "draft" | "verified" | "fallback" | "error" | "interrupted";

export type Answer = {
  readonly status: AnswerStatus;
  readonly text: string;
  readonly sources: readonly ChatSource[];
  readonly suggestions: readonly string[];
  readonly proposal: { readonly programId: string; readonly programName: string } | null;
  readonly contact: string | null;
  readonly errorMessage: string | null;
};

export const EMPTY_ANSWER: Answer = {
  status: "waiting",
  text: "",
  sources: [],
  suggestions: [],
  proposal: null,
  contact: null,
  errorMessage: null,
};

/** イベントを1つ適用する。確定（verified/fallback/error）の後の delta は無視する */
export function applyChatEvent(a: Answer, e: ChatEvent): Answer {
  const finished = a.status === "verified" || a.status === "fallback" || a.status === "error";
  switch (e.type) {
    case "status":
      return a;
    case "delta":
      return finished ? a : { ...a, status: "draft", text: a.text + e.text };
    case "reset":
      // 検証に通らなかった下書きを破棄する（1回だけ再生成される）
      return finished ? a : { ...a, status: "waiting", text: "" };
    case "verified":
      return { ...a, status: "verified" };
    case "sources":
      return { ...a, sources: [...e.sources] };
    case "suggestions":
      return { ...a, suggestions: e.suggestions.slice(0, SUGGESTIONS_MAX) };
    case "proposal":
      return { ...a, proposal: { programId: e.programId, programName: e.programName } };
    case "fallback":
      // 本文は事実として表示しない
      return { ...a, status: "fallback", text: "", sources: [...e.sources], contact: e.contact };
    case "error":
      return {
        ...a,
        status: "error",
        errorMessage: e.message + (e.retryAt ? `（${e.retryAt} から再開します）` : ""),
      };
  }
}

/** ストリームが確定前に切れたとき。途中までの回答は残す（Requirement 12.7） */
export function interruptAnswer(a: Answer): Answer {
  return a.status === "verified" || a.status === "fallback" || a.status === "error"
    ? a
    : { ...a, status: "interrupted" };
}

/** SSE のメッセージを ChatEvent に変える。形が違うものは null */
export function toChatEvent(event: string, data: string): ChatEvent | null {
  let body: unknown = {};
  try {
    body = data ? JSON.parse(data) : {};
  } catch {
    if (event === "delta") return { type: "delta", text: data };
    return null;
  }
  const o = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  const sources = (v: unknown): ChatSource[] =>
    Array.isArray(v)
      ? v.flatMap((s) =>
          typeof s === "object" && s !== null && typeof (s as ChatSource).url === "string"
            ? [s as ChatSource]
            : [],
        )
      : [];
  switch (event) {
    case "status":
      return { type: "status", status: str("status") };
    case "delta":
      return { type: "delta", text: str("text") };
    case "reset":
      return { type: "reset" };
    case "verified":
      return { type: "verified" };
    case "sources":
      return { type: "sources", sources: sources(o["sources"]) };
    case "suggestions":
      return {
        type: "suggestions",
        suggestions: Array.isArray(o["suggestions"])
          ? o["suggestions"].filter((x): x is string => typeof x === "string")
          : [],
      };
    case "proposal":
      return str("programId")
        ? { type: "proposal", programId: str("programId"), programName: str("programName") }
        : null;
    case "fallback":
      return { type: "fallback", sources: sources(o["sources"]), contact: str("contact") };
    case "error":
      return {
        type: "error",
        message: str("message") || "回答を作れませんでした",
        ...(str("retryAt") ? { retryAt: str("retryAt") } : {}),
      };
    default:
      return null;
  }
}

/** 質問の文字数の検証（1〜500文字。コードポイント数） */
export function checkQuestion(text: string): {
  readonly ok: boolean;
  readonly count: number;
  readonly message: string | null;
} {
  const count = [...text].length;
  if (text.trim().length === 0) return { ok: false, count, message: null };
  if (count > QUESTION_MAX)
    return { ok: false, count, message: `質問は最大${QUESTION_MAX}文字です（いま${count}文字）` };
  return { ok: true, count, message: null };
}

/** 回答本文を、引用番号 [n] とそれ以外に分ける（引用番号はリンクにする） */
export function splitCitations(
  text: string,
): Array<
  { readonly kind: "text"; readonly text: string } | { readonly kind: "cite"; readonly n: number }
> {
  const out: Array<{ kind: "text"; text: string } | { kind: "cite"; n: number }> = [];
  const re = /\[(\d{1,2})\]/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    out.push({ kind: "cite", n: Number(m[1]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}
