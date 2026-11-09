// 登録・オンボーディングの入力検証（Requirement 1.3, 1.4, 2.1〜2.13, 11.7, 11.8）
// クライアントのフォーム検証と、API の受け付け時の検証の両方で使う純粋関数。

import {
  addMonthsClamped,
  compareIsoDate,
  formatIsoDate,
  parseIsoDate,
  toSlashDate,
} from "./date.js";

/** 入力欄ごとのエラー。field は画面の入力欄に対応する（例: "children.0.ageYears"） */
export type FieldError = { readonly field: string; readonly message: string };
export type ValidationResult = { readonly ok: boolean; readonly errors: readonly FieldError[] };

const result = (errors: FieldError[]): ValidationResult => ({ ok: errors.length === 0, errors });

/** 文字数はコードポイント数で数える（絵文字などのサロゲートペアを1文字とする） */
export function charCount(value: string): number {
  return [...value].length;
}

// ---- メールアドレスとパスワード（Property 1） ----

export const EMAIL_MAX_LENGTH = 254;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_LABEL_CHARS = /^[A-Za-z0-9-]+$/;
// ドメインのラベルは1〜63文字、英数字とハイフン。先頭と末尾はハイフン以外
const isDomainLabel = (label: string): boolean =>
  label.length >= 1 &&
  label.length <= 63 &&
  DOMAIN_LABEL_CHARS.test(label) &&
  !label.startsWith("-") &&
  !label.endsWith("-");
const TLD = /^[A-Za-z][A-Za-z0-9-]*$/;

/**
 * 254文字以内で、`ローカル部@ドメイン` の形式のときに真。
 * ローカル部は dot-atom（記号を含む英数字を1つのドットで区切る）、
 * ドメインは2つ以上のラベルで、最後のラベルは英字で始まる。
 */
export function validateEmail(email: string): boolean {
  if (email.length === 0 || email.length > EMAIL_MAX_LENGTH) return false;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!local.split(".").every((atom) => LOCAL_PART.test(atom))) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  if (!labels.every(isDomainLabel)) return false;
  return TLD.test(labels[labels.length - 1] ?? "");
}

/** 8〜128文字（コードポイント数）のときに真 */
export function validatePassword(password: string): boolean {
  const n = charCount(password);
  return n >= PASSWORD_MIN_LENGTH && n <= PASSWORD_MAX_LENGTH;
}

export const EMAIL_FORMAT_MESSAGE =
  "メールアドレスの形式が正しくありません（例：name@example.com）";
export const PASSWORD_LENGTH_MESSAGE = "パスワードは8〜128文字で入れてください";

/** 登録フォームの検証。無効な欄ごとにエラーを返す（Requirement 1.4） */
export function validateSignUp(input: { email: string; password: string }): ValidationResult {
  const errors: FieldError[] = [];
  if (!validateEmail(input.email)) errors.push({ field: "email", message: EMAIL_FORMAT_MESSAGE });
  if (!validatePassword(input.password)) {
    errors.push({ field: "password", message: PASSWORD_LENGTH_MESSAGE });
  }
  return result(errors);
}

// ---- 郵便番号（Property 3） ----

export const HACHIOJI_MUNICIPALITY_CODE = "13201";
export const TOKYO_MUNICIPALITY_CODE = "13000";
export const NATIONAL_MUNICIPALITY_CODE = "00000";

export type PostalEntry = {
  readonly municipalityCode: string;
  readonly prefecture: string;
  readonly city: string;
  readonly town: string;
};

/** 郵便番号（ハイフンなし7桁）→ 住所。本番は全国の表、テストは小さな表を渡す */
export type PostalTable = ReadonlyMap<string, PostalEntry>;

export type PostalClassification =
  | { readonly kind: "hachioji"; readonly postalCode: string; readonly entry: PostalEntry }
  | { readonly kind: "outside"; readonly postalCode: string; readonly entry: PostalEntry }
  | { readonly kind: "notFound"; readonly postalCode: string }
  | { readonly kind: "invalidFormat" };

const POSTAL_CODE = /^\d{7}$/;

/**
 * 入力の揺れをそろえる: 全角数字を半角に、3桁目の後のハイフン（-、－、ー）を取り除く。
 * それ以外の文字は残すので、7桁の数字にならなければ invalidFormat になる。
 */
export function normalizePostalCode(raw: string): string {
  const half = raw.trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  return /^\d{3}[-－ー]\d{4}$/.test(half) ? half.slice(0, 3) + half.slice(4) : half;
}

export function classifyPostalCode(raw: string, table: PostalTable): PostalClassification {
  const postalCode = normalizePostalCode(raw);
  if (!POSTAL_CODE.test(postalCode)) return { kind: "invalidFormat" };
  const entry = table.get(postalCode);
  if (!entry) return { kind: "notFound", postalCode };
  return entry.municipalityCode === HACHIOJI_MUNICIPALITY_CODE
    ? { kind: "hachioji", postalCode, entry }
    : { kind: "outside", postalCode, entry };
}

/** 本番用の読み込み口: 郵便番号データの行から表を作る（同じ郵便番号は最初の行を使う） */
export function buildPostalTable(
  rows: Iterable<{ readonly postalCode: string } & PostalEntry>,
): PostalTable {
  const table = new Map<string, PostalEntry>();
  for (const { postalCode, ...entry } of rows) {
    const code = normalizePostalCode(postalCode);
    if (POSTAL_CODE.test(code) && !table.has(code)) table.set(code, entry);
  }
  return table;
}

/** 開発・テスト用の小さな表（八王子市の数件と、市外の例） */
export const SAMPLE_POSTAL_TABLE: PostalTable = buildPostalTable([
  {
    postalCode: "1920083",
    municipalityCode: "13201",
    prefecture: "東京都",
    city: "八王子市",
    town: "旭町",
  },
  {
    postalCode: "1920081",
    municipalityCode: "13201",
    prefecture: "東京都",
    city: "八王子市",
    town: "横山町",
  },
  {
    postalCode: "1920046",
    municipalityCode: "13201",
    prefecture: "東京都",
    city: "八王子市",
    town: "明神町",
  },
  {
    postalCode: "1920904",
    municipalityCode: "13201",
    prefecture: "東京都",
    city: "八王子市",
    town: "子安町",
  },
  {
    postalCode: "1000001",
    municipalityCode: "13101",
    prefecture: "東京都",
    city: "千代田区",
    town: "千代田",
  },
]);

export const POSTAL_MESSAGES = {
  invalidFormat: "郵便番号は7桁の数字で入れてください",
  notFound: "この郵便番号は見つかりませんでした",
  outside: "いまは八王子市だけに対応しています。国の制度だけで続けることもできます。",
} as const;

// ---- 子ども・自由記述（Property 4） ----

export const CHILDREN_MAX = 20;
export const CHILD_AGE_MAX = 18;
export const MONTHS_MAX = 11;
export const FREE_TEXT_MAX = 200;

export type ChildInput = { readonly ageYears: number; readonly ageMonths?: number };

const isIntIn = (n: unknown, min: number, max: number): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;

/** 人数0〜20、年齢0〜18の整数、月齢は年齢0のときのみ0〜11 */
export function validateChildren(children: readonly ChildInput[]): ValidationResult {
  const errors: FieldError[] = [];
  if (children.length > CHILDREN_MAX) {
    errors.push({
      field: "childCount",
      message: `子どもの人数は0〜${CHILDREN_MAX}人で入れてください`,
    });
  }
  children.forEach((c, i) => {
    if (!isIntIn(c.ageYears, 0, CHILD_AGE_MAX)) {
      errors.push({
        field: `children.${i}.ageYears`,
        message: `年齢は0〜${CHILD_AGE_MAX}歳で入れてください`,
      });
      return;
    }
    if (c.ageMonths === undefined) return;
    if (c.ageYears !== 0) {
      errors.push({ field: `children.${i}.ageMonths`, message: "月齢は0歳のときだけ入れられます" });
    } else if (!isIntIn(c.ageMonths, 0, MONTHS_MAX)) {
      errors.push({
        field: `children.${i}.ageMonths`,
        message: "0歳の月齢は0〜11か月で入力してください",
      });
    }
  });
  return result(errors);
}

/** 自由記述は200文字以内（空でもよい） */
export function validateFreeText(text: string): ValidationResult {
  return result(
    charCount(text) > FREE_TEXT_MAX
      ? [
          {
            field: "freeText",
            message: `${FREE_TEXT_MAX}文字以内で入れてください（いま${charCount(text)}文字）`,
          },
        ]
      : [],
  );
}

// ---- 出産予定日（Property 7） ----

/** 出産予定日として受け付ける最後の日（入力日の10か月後の同日。存在しない日は月末） */
export function dueDateMax(today: string): string | null {
  const t = parseIsoDate(today);
  return t ? formatIsoDate(addMonthsClamped(t, 10)) : null;
}

/** 入力日の当日〜10か月後の同日の範囲にあれば真 */
export function validateDueDate(date: string, today: string): boolean {
  const max = dueDateMax(today);
  if (!max || !parseIsoDate(date)) return false;
  return compareIsoDate(date, today) >= 0 && compareIsoDate(date, max) <= 0;
}

export function dueDateRangeMessage(today: string): string {
  const max = dueDateMax(today) ?? today;
  return `出産予定日は ${toSlashDate(today)} から ${toSlashDate(max)} までの日付で入れてください`;
}

// ---- 世帯入力の必須項目（Property 5） ----

export type HouseholdInput = {
  readonly postalCode: string;
  readonly children: readonly ChildInput[];
  /** 妊娠中・出産予定（YYYY-MM-DD）。人数0のときは必須 */
  readonly dueDate?: string;
  /** 状況チップ（要配慮情報を含む） */
  readonly situationChips?: readonly string[];
  /** 自由記述（200文字以内） */
  readonly freeText?: string;
};

/**
 * 必須3項目（郵便番号・子どもの人数・年齢または出産予定日）が有効なら成功する（Requirement 2.5）。
 * - 市外の郵便番号は成功（国の制度だけで続けられる）。存在しない番号・形式違いは失敗
 * - 人数0のときは有効な出産予定日が必須。人数1以上なら未入力でもよいが、入れたなら範囲内であること
 */
export function validateHouseholdInput(
  input: HouseholdInput,
  today: string,
  table: PostalTable,
): ValidationResult {
  const errors: FieldError[] = [];
  const postal = classifyPostalCode(input.postalCode, table);
  if (postal.kind === "invalidFormat" || postal.kind === "notFound") {
    errors.push({ field: "postalCode", message: POSTAL_MESSAGES[postal.kind] });
  }
  errors.push(...validateChildren(input.children).errors);
  const dueDate = input.dueDate === "" ? undefined : input.dueDate;
  if (dueDate === undefined) {
    if (input.children.length === 0) {
      errors.push({ field: "dueDate", message: "子どもが0人のときは、出産予定日を入れてください" });
    }
  } else if (!validateDueDate(dueDate, today)) {
    errors.push({ field: "dueDate", message: dueDateRangeMessage(today) });
  }
  if (input.freeText !== undefined) errors.push(...validateFreeText(input.freeText).errors);
  return result(errors);
}
