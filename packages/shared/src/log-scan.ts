// ログ出力の個人情報・シークレットのスキャン（Requirement 15.3）
// テスト実行中の標準出力・標準エラーを集めたテキストを検査する。

export type LeakKind =
  | "email"
  | "phone"
  | "postalCode"
  | "googleApiKey"
  | "privateKey"
  | "jwt"
  | "bearerToken"
  | "githubToken"
  | "googleOAuthToken"
  | "canary";

export type LeakFinding = {
  kind: LeakKind;
  /** 1始まりの行番号 */
  line: number;
};

// 英数字に隣接しない（UUID やハッシュの一部を誤検出しない）
const NB = "(?<![0-9A-Za-z-])";
const NA = "(?![0-9A-Za-z-])";

const PATTERNS: ReadonlyArray<readonly [LeakKind, RegExp]> = [
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  // 固定電話・携帯（ハイフンあり）と、携帯（ハイフンなし 070/080/090 + 8桁）
  ["phone", new RegExp(`${NB}(?:0\\d{1,4}-\\d{1,4}-\\d{3,4}|0[789]0\\d{8})${NA}`)],
  ["postalCode", new RegExp(`${NB}(?:〒\\s?)?\\d{3}-\\d{4}${NA}`)],
  ["googleApiKey", /AIza[0-9A-Za-z_-]{35}/],
  ["privateKey", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["jwt", /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/],
  ["bearerToken", /Bearer\s+[A-Za-z0-9._~+/-]{20,}=*/],
  ["githubToken", /gh[pousr]_[A-Za-z0-9]{36,}/],
  ["googleOAuthToken", /ya29\.[0-9A-Za-z_-]{20,}/],
];

export type ScanOptions = {
  /** テストの入力に埋め込んだ一意な文字列（質問文の本文など）。1件でも現れたら検出する */
  canaries?: readonly string[];
};

/** テキストを行ごとに検査し、個人情報・シークレットらしい文字列の位置を返す（内容は返さない） */
export function scanLogForLeaks(text: string, options: ScanOptions = {}): LeakFinding[] {
  const canaries = (options.canaries ?? []).filter((c) => c.length > 0);
  const findings: LeakFinding[] = [];
  text.split(/\r?\n/).forEach((content, index) => {
    const line = index + 1;
    for (const [kind, pattern] of PATTERNS) {
      if (pattern.test(content)) findings.push({ kind, line });
    }
    if (canaries.some((c) => content.includes(c))) {
      findings.push({ kind: "canary", line });
    }
  });
  return findings;
}
