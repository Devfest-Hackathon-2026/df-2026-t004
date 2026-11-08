// コマンドを実行し、標準出力・標準エラーを画面に出しながらファイルにも保存する（tee 相当）。
// ログの個人情報スキャン（npm run test:log-scan）の入力を作るために使う。
//
// 使い方: node scripts/capture-output.mjs <保存先> <コマンド> [引数...]
// 例:     node scripts/capture-output.mjs logs/test-output.log npm run test:integration:raw
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const [outFile, ...command] = process.argv.slice(2);
if (!outFile || command.length === 0) {
  console.error("usage: node scripts/capture-output.mjs <out-file> <command> [args...]");
  process.exit(2);
}

// 保存先はコマンドラインで指定した開発者自身のパス
// eslint-disable-next-line security/detect-non-literal-fs-filename
mkdirSync(dirname(outFile), { recursive: true });
// eslint-disable-next-line security/detect-non-literal-fs-filename
const out = createWriteStream(outFile, { flags: "w" });

// Windows で npm / firebase などの .cmd を解決するため shell を使う（引数は開発者の npm スクリプトのみ）。
// 空白を含む引数は二重引用符で囲む。
const quote = (arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);
const child = spawn(command.map(quote).join(" "), {
  shell: true,
  stdio: ["inherit", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  out.write(chunk);
});
child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  out.write(chunk);
});

child.on("close", (code, signal) => {
  out.end(() => {
    process.exit(code ?? (signal ? 1 : 0));
  });
});
