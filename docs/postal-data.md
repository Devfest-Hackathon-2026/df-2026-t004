# 郵便番号データ（設計書 U-13）

API は、全国の郵便番号の表 `packages/api/data/postal-codes.tsv.gz` を起動時に読み込み、郵便番号から住所と市区町村（全国地方公共団体コード）を出します。八王子市（`13201`）か、市外か、存在しない番号かは `classifyPostalCode` が決めます。テストとモックは開発用の小さな表 `SAMPLE_POSTAL_TABLE` のままです。

## データ元と利用条件

- データ元: 日本郵便「[住所の郵便番号（1レコード1行、UTF-8形式）](https://www.post.japanpost.jp/service/search/zipcode/download/utf-zip.html)」の `utf_ken_all.zip`
- 利用条件: [郵便番号データの説明](https://www.post.japanpost.jp/service/search/zipcode/download/utf-readme.html)で、郵便番号データについては著作権を主張せず、自由に配布してよいとされています
- 更新頻度: 毎月末に更新されます
- いまの表: 2026年10月30日更新分（120,721件）

## 表の形

1行1郵便番号の TSV を gzip したもの。列は「郵便番号（7桁）、地方公共団体コード（5桁）、都道府県、市区町村、町域」。

- 同じ郵便番号が複数の町域に対応するときは、最初の行だけを残します（`buildPostalTable` と同じ）。住所の表示は町域まで出ませんが、市区町村の判定には影響しません
- 町域の「以下に掲載がない場合」は空にし、「（」以降の補足は取り除きます

読み込みは約0.2秒、メモリは約25MBです。

## 更新の手順

1. 上のページから `utf_ken_all.zip` をダウンロードし、リポジトリの外の空のフォルダで展開します
2. 表を作り直します

   ```bash
   node scripts/gen-postal-table.mjs <展開した utf_ken_all.csv のパス>
   ```

3. `npx vitest run packages/api/test/postal-data.test.ts` を通し、この文書の「いまの表」の日付と件数を直して PR を出します
4. マージ後に API を再デプロイします（表はイメージに含まれます）

更新は、八王子市の郵便番号に変更があったときか、半年に1回を目安にします。
