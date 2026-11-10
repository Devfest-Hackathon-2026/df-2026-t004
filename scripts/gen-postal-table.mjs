// 日本郵便の郵便番号データ（住所の郵便番号、1レコード1行、UTF-8）から、API が読む表を作る。
//
//   1. https://www.post.japanpost.jp/service/search/zipcode/download/utf-zip.html から
//      utf_ken_all.zip をダウンロードして展開する
//   2. node scripts/gen-postal-table.mjs <utf_ken_all.csv のパス>
//
// 出力: packages/api/data/postal-codes.tsv.gz
//   1行1郵便番号で「郵便番号<TAB>地方公共団体コード<TAB>都道府県<TAB>市区町村<TAB>町域」。
//   同じ郵便番号が複数行あるときは最初の行を使う（buildPostalTable と同じ）。

import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const OUTPUT = "packages/api/data/postal-codes.tsv.gz";

const input = process.argv[2];
if (input === undefined) {
  console.error("使い方: node scripts/gen-postal-table.mjs <utf_ken_all.csv>");
  process.exit(1);
}

/** 町域を表示用にそろえる。「以下に掲載がない場合」は空、括弧の補足は取り除く */
function townOf(raw) {
  if (raw === "以下に掲載がない場合") return "";
  const i = raw.indexOf("（");
  return i === -1 ? raw : raw.slice(0, i);
}

const seen = new Set();
const lines = [];
// eslint-disable-next-line security/detect-non-literal-fs-filename -- 運営者が指定する入力ファイル
for (const line of readFileSync(input, "utf8").split(/\r?\n/)) {
  if (line === "") continue;
  const cols = line.split(",").map((c) => c.replace(/^"|"$/g, ""));
  const [municipalityCode, , postalCode, , , , prefecture, city, town] = cols;
  if (!/^\d{5}$/.test(municipalityCode) || !/^\d{7}$/.test(postalCode)) {
    throw new Error(`読めない行です: ${line.slice(0, 40)}`);
  }
  if (seen.has(postalCode)) continue;
  seen.add(postalCode);
  lines.push([postalCode, municipalityCode, prefecture, city, townOf(town)].join("\t"));
}

writeFileSync(OUTPUT, gzipSync(`${lines.join("\n")}\n`, { level: 9 }));
console.log(`${lines.length} 件を ${OUTPUT} に書き出しました`);
