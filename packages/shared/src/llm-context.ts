// LLM に渡す情報の制限（Requirement 9.9, 9.13）

import { SOURCE_AGE_BANDS, type SourceAgeBand } from "./collection.js";

export type LlmHouseholdContext = {
  // 5桁の自治体コード。形が違うときは null（何も渡さない）
  municipalityCode: string | null;
  ageBands: SourceAgeBand[];
};

/**
 * 世帯情報から、LLM に渡す属性（自治体と年齢区分）だけを取り出す。
 * 氏名・住所・連絡先・出産予定日・要配慮情報は、入力にあっても出力に含めない。
 * 年齢区分は既知の値だけを、決まった順に重複なく残す。
 */
export function buildLlmContext(household: {
  municipalityCode: unknown;
  ageBands: unknown;
}): LlmHouseholdContext {
  const code = household.municipalityCode;
  const bands: unknown[] = Array.isArray(household.ageBands) ? household.ageBands : [];
  return {
    municipalityCode: typeof code === "string" && /^\d{5}$/.test(code) ? code : null,
    ageBands: SOURCE_AGE_BANDS.filter((b) => bands.includes(b)),
  };
}

export const PII_PLACEHOLDERS = {
  email: "[メールアドレス]",
  phone: "[電話番号]",
  postalCode: "[郵便番号]",
} as const;

const EMAIL_LOCAL_CHARS = "!#$%&'*+/=?^_`{|}~.-";

function isAsciiAlnum(ch: string): boolean {
  return /^[A-Za-z0-9]$/.test(ch);
}

/**
 * メールアドレスを置き換える。正規表現で探すと、@ の無い長い記号の並びで
 * 処理が文字数の2乗に遅くなるため、@ から左右に1文字ずつ広げて探す（線形時間）。
 * ドメインは「.」を1つ以上含むもの。末尾の「.」は文の終わりとして残す。
 */
function maskEmails(text: string): string {
  let out = "";
  let last = 0; // ここまでは out に書き出し済み
  let runStart = 0; // いま続いているローカル部の文字の並びの先頭
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch !== "@" && ch !== "＠") {
      if (!isAsciiAlnum(ch) && !EMAIL_LOCAL_CHARS.includes(ch)) runStart = i + 1;
      continue;
    }
    const start = Math.max(runStart, last);
    let end = i + 1;
    while (end < text.length && (isAsciiAlnum(text.charAt(end)) || "-.".includes(text.charAt(end))))
      end++;
    while (end > i + 1 && text.charAt(end - 1) === ".") end--;
    const domain = text.slice(i + 1, end);
    runStart = i + 1;
    if (start < i && domain.indexOf(".") > 0) {
      out += text.slice(last, start) + PII_PLACEHOLDERS.email;
      last = end;
      runStart = end;
      i = end - 1;
    }
  }
  return out + text.slice(last);
}

// 先頭が 0 か +81。区切りはハイフン・括弧・空白。数字が10桁未満のものは電話番号とみなさない
const PHONE =
  /(?<![0-9０-９])(?:[+＋]81[-‐－−ー]?\s?|[0０])[0-9０-９]{1,4}[-‐－−ー(（)）\s]{0,2}[0-9０-９]{1,4}[-‐－−ー)）\s]{0,2}[0-9０-９]{3,4}(?![0-9０-９])/g;
// 〒 付きの7桁、または 3桁-4桁。電話番号の一部（042-000-0000 の 000-0000 など）と、
// 金額や年齢の範囲（500-1000円 など）は除く
const POSTAL =
  /〒\s?[0-9０-９]{3}[-‐－−ー]?[0-9０-９]{4}(?![0-9０-９])|(?<![0-9０-９])(?<![0-9０-９][-‐－−ー])[0-9０-９]{3}[-‐－−ー][0-9０-９]{4}(?![0-9０-９])(?![-‐－−ー][0-9０-９])(?![円万歳人件日月年回%％])/g;

function digitCount(s: string): number {
  return (s.match(/[0-9０-９]/g) ?? []).length;
}

/**
 * 質問文のメールアドレス・電話番号・郵便番号を固定の文字列に置き換える。
 * 置換後の文字列には数字も @ も含まれないため、2回かけても結果は変わらない。
 * 郵便番号を電話番号より先に置き換える（隣の数字と続けて電話番号と誤認しないため）。
 */
export function maskPii(text: string): string {
  return maskEmails(text)
    .replace(POSTAL, PII_PLACEHOLDERS.postalCode)
    .replace(PHONE, (m) => (digitCount(m) >= 10 ? PII_PLACEHOLDERS.phone : m));
}
