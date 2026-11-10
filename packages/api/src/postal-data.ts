// 全国の郵便番号の表（日本郵便の郵便番号データから scripts/gen-postal-table.mjs で作る）

import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { buildPostalTable, type PostalTable } from "@hachioji-gov/shared";

export const POSTAL_DATA_URL = new URL("../data/postal-codes.tsv.gz", import.meta.url);

/** 「郵便番号<TAB>地方公共団体コード<TAB>都道府県<TAB>市区町村<TAB>町域」の行から表を作る */
export function parsePostalTsv(text: string): PostalTable {
  const rows = text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [postalCode = "", municipalityCode = "", prefecture = "", city = "", town = ""] =
        line.split("\t");
      if (!/^\d{5}$/.test(municipalityCode)) throw new Error("郵便番号の表が不正です");
      return { postalCode, municipalityCode, prefecture, city, town };
    });
  return buildPostalTable(rows);
}

export async function loadPostalTable(url: URL = POSTAL_DATA_URL): Promise<PostalTable> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 同梱の固定ファイル（テストでだけ差し替える）
  return parsePostalTsv(gunzipSync(await readFile(url)).toString("utf8"));
}
