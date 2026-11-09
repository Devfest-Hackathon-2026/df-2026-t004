// 質問文の長さと、次の質問候補の件数（Requirement 5.7, 5.9, 13.10）

export const QUESTION_MAX_CHARS = 500;
export const SUGGESTIONS_LIMIT = 3;

export type QuestionCheck =
  | { ok: true; value: string; length: number }
  | { ok: false; reason: "empty" | "tooLong"; length: number; message: string };

/**
 * 質問文を検証する。文字数はコードポイントで数える（絵文字も1文字）。
 * 空白だけの質問は受け付けない。拒否時のメッセージには上限と現在の文字数を入れる。
 */
export function validateQuestion(text: string): QuestionCheck {
  const length = [...text].length;
  if (text.trim() === "") {
    return {
      ok: false,
      reason: "empty",
      length,
      message: `質問を入力してください（最大${QUESTION_MAX_CHARS}文字、現在${length}文字）`,
    };
  }
  if (length > QUESTION_MAX_CHARS) {
    return {
      ok: false,
      reason: "tooLong",
      length,
      message: `質問は最大${QUESTION_MAX_CHARS}文字です（現在${length}文字）`,
    };
  }
  return { ok: true, value: text, length };
}

/** 次の質問候補を、先頭から最大 limit 件にする。順序は変えない */
export function limitSuggestions<T>(list: readonly T[], limit: number = SUGGESTIONS_LIMIT): T[] {
  return list.slice(0, Math.max(0, limit));
}
