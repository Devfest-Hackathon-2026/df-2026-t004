// PR タイトルが docs/commit-convention.md の形式であることを検査する（Requirement 15.10）
//
// 使い方: PR_TITLE="feat(web): add tab bar" node scripts/check-pr-title.mjs
// タイトルは環境変数で受け取る（ワークフローでシェルに直接埋め込まないため）。
import { pathToFileURL } from "node:url";

export const TYPES = [
  "feat",
  "fix",
  "security",
  "docs",
  "spec",
  "test",
  "refactor",
  "perf",
  "style",
  "build",
  "ci",
  "chore",
  "revert",
];

export const MAX_LENGTH = 72;

/**
 * `<type>(<scope>)!: <summary>` を分解する。形式が違えば null。
 * （入れ子の量指定子を持つ正規表現を避けるため、段階的に読む）
 * @param {string} title
 * @returns {{ type: string; summary: string } | null}
 */
function parseHeader(title) {
  const sep = title.indexOf(": ");
  if (sep <= 0) return null;
  let head = title.slice(0, sep);
  const summary = title.slice(sep + 2);
  if (summary.length === 0) return null;
  const type = /^[a-z]+/.exec(head)?.[0];
  if (type === undefined) return null;
  head = head.slice(type.length);
  const scope = /^\([a-z0-9-]+\)/.exec(head)?.[0];
  if (scope !== undefined) head = head.slice(scope.length);
  if (head === "!") head = "";
  return head === "" ? { type, summary } : null;
}

/**
 * PR タイトルを検査し、問題の一覧を返す（空なら合格）。
 * @param {string} title
 * @returns {string[]}
 */
export function validatePrTitle(title) {
  const problems = [];
  if (title.length > MAX_LENGTH) {
    problems.push(`72文字以内にしてください（現在 ${title.length} 文字）`);
  }
  const header = parseHeader(title);
  if (header === null) {
    problems.push("`<type>(<scope>): <summary>` の形式にしてください（scope は省略可）");
    return problems;
  }
  const { type, summary } = header;
  if (!TYPES.includes(type)) {
    problems.push(`type "${type}" は使えません。使える type: ${TYPES.join(", ")}`);
  }
  if (summary !== summary.trim()) {
    problems.push("summary の前後に空白を入れないでください");
  }
  if (/^[A-Z]/.test(summary)) {
    problems.push("summary は小文字で始めてください");
  }
  if (summary.endsWith(".")) {
    problems.push("summary の末尾にピリオドを付けないでください");
  }
  return problems;
}

// コマンドとして実行されたときだけ動く
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const title = process.env.PR_TITLE ?? "";
  const problems = validatePrTitle(title);
  if (problems.length > 0) {
    console.error(`PR タイトルが規約に合っていません: ${JSON.stringify(title)}`);
    for (const p of problems) console.error(`- ${p}`);
    console.error("規約: docs/commit-convention.md");
    process.exit(1);
  }
  console.log(`OK: ${title}`);
}
