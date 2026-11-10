# 制度の確認（verify）の手順

収集した制度について、AI が原文から抜き出した「対象・締切・必要書類」が原文と合っているかを人が確かめ、`verify` で確認済みにする手順です（UW-GC-17、#55）。

- 確認済みにした制度だけが、アプリのホームの「対象の可能性がある制度」と AI 相談の検索に出ます。
- 所要時間: 1 制度あたり 3〜5 分。

## 前提

- 運営者（`admin` クレームを持つアカウント）でログイン済みの Cloud Shell で作業します。
  - Cloud Shell は https://console.cloud.google.com でプロジェクト `hachioji-gov` を選び、右上の `>_` から開きます。
  - リポジトリは `~/GDGoC2026` に clone 済み、運営者の資格情報（ADC）は作成済みであること（[google-cloud-setup.md](google-cloud-setup.md) の手順7）。
- **確認者として記録されるのは、Cloud Shell にログインしているアカウントの uid です**（`verifiedBy`）。別の人が作業するときは、そのことを了承した上で行います。

## 1. 準備（Cloud Shell を開くたびに）

```bash
export P=hachioji-gov && cd ~/GDGoC2026 && { nvm use 22 || nvm install 22; }
```

運営者の資格情報が残っているかを確かめます。`ADC OK` と出れば大丈夫です。

```bash
gcloud auth application-default print-access-token >/dev/null && echo "ADC OK"
```

出ない場合は、運営者本人に `gcloud auth application-default login` と `gcloud auth application-default set-quota-project hachioji-gov` を実行してもらいます（表示されるコードは誰にも送らないでください）。

運営者の uid を変数に入れます（ログイン中のアカウントのメールアドレスから探します）。

```bash
MY_EMAIL=$(gcloud config get-value account 2>/dev/null) && ADMIN_UID=$(curl -s -X POST -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "X-Goog-User-Project: $P" -H "Content-Type: application/json" -d '{}' "https://identitytoolkit.googleapis.com/v1/projects/$P/accounts:query" | MY_EMAIL="$MY_EMAIL" python3 -c 'import json,sys,os; u=[x for x in json.load(sys.stdin).get("userInfo",[]) if x.get("email")==os.environ["MY_EMAIL"]]; print(u[0]["localId"] if u else "")'); echo "uid の長さ: ${#ADMIN_UID}"
```

`uid の長さ: 28` のような数字が出れば OK です。`0` のときは、そのアカウントでアプリ（https://hachioji-gov.web.app）に一度もログインしていません。

## 2. 制度を確認する（制度ごとに繰り返す）

`<id>` を、下の対照表の ID に置き換えて実行します。

```bash
npm run admin -- --project $P --operator "$ADMIN_UID" verify <id>
```

例:

```bash
npm run admin -- --project $P --operator "$ADMIN_UID" verify city-jido-teate
```

画面に次の内容が出ます。

| 表示 | 意味 |
|---|---|
| `対象（抽出）` / `締切（抽出）` / `必要書類（抽出）` | AI が原文から抜き出した内容 |
| `原文抜粋（N件）` | 収集したページ（と添付の PDF）の本文 |
| `状態: verified=… needsReview=…` | 今の確認の状態 |

### 確認の仕方

1. 対照表の URL をブラウザで開き、原文と見比べる。
2. 抜き出した **対象・締切・必要書類が、原文と食い違っていないか** を見る。
   - `（読み取れず）` は問題ありません。アプリは「原文を確認してください」と案内します。
   - 締切は、原文に **日付** が明記されているときだけ入ります。「心拍確認から2年間」のような期間は `（読み取れず）` になるのが正常です。
   - 誤り（対象の年齢や条件が違う、日付が違う、書類が違う、原文にないことが書いてある）があれば NG。
3. 問題なければ `yes` と入力して Enter → `確認済みにしました` と出ます。
4. NG なら、何も入力せずに Enter → `中止しました。変更はありません。` と出ます。**ID と、どこが違ったかをメモ**しておきます。

### 制度と原文の対照表

| # | ID | 制度 | 原文 | 結果 |
|---|---|---|---|---|
| 1 | `city-ninpu-shien-kyufu` | 妊婦のための支援給付 | https://kosodate.city.hachioji.tokyo.jp/nenrei/ninshin_shussan/3400.html | |
| 2 | `city-ninshin-todokede` | 妊娠届出・母子健康手帳交付・妊婦面談 | https://kosodate.city.hachioji.tokyo.jp/scene/akachannideaumade/ninshinshitara/961.html | |
| 3 | `city-ninpu-kenshin` | 妊婦健康診査 | https://kosodate.city.hachioji.tokyo.jp/scene/akachannideaumade/mamanokenkokanri/970.html | |
| 4 | `city-shokai-sanka-jushin` | 初回産科受診料助成 | https://kosodate.city.hachioji.tokyo.jp/scene/akachannideaumade/sanzensangonoshien/2956.html | |
| 5 | `city-sango-care` | 産後ケア事業 | https://kosodate.city.hachioji.tokyo.jp/scene/akachannideaumade/sanzensangonoshien/985.html | |
| 6 | `city-jido-teate` | 児童手当 | https://kosodate.city.hachioji.tokyo.jp/nenrei/1_2sai/sodan_support/1178.html | |
| 7 | `city-marunyu` | 乳幼児医療費助成（マル乳） | https://kosodate.city.hachioji.tokyo.jp/nenrei/1_2sai/sodan_support/1180.html | |
| 8 | `city-yobo-sesshu` | 子どもの予防接種 | https://www.city.hachioji.tokyo.jp/kurashi/hoken/007/yobosesshu/koyobosesshu/p002668.html | |
| 9 | `city-hoiku-nyuen` | 保育施設の入園申込 | https://kosodate.city.hachioji.tokyo.jp/scene/hoikuen_yochien_ninteikodomoen/nyuennotetsuzuki/890.html | |
| 10 | `tokyo-kyukyu-sodan` | 東京消防庁救急相談センター（#7119） | https://www.tfd.metro.tokyo.lg.jp/lfe/kyuu_adv/soudan-center.html | |
| 11 | `national-shussan-ikuji-ichijikin` | 出産育児一時金 | https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/kenkou_iryou/iryouhoken/shussan/index.html | |
| 12 | `city-misyuen-shika` | 4歳児・5歳児 未就園児の歯科健診 | https://kosodate.city.hachioji.tokyo.jp/nenrei/3sai_shugakumae/kenshin_kenkokanri/1167.html | |
| 13 | `city-yochien-mushouka` | 幼稚園等の幼児教育・保育の無償化 | https://kosodate.city.hachioji.tokyo.jp/scene/hoikuen_yochien_ninteikodomoen/yochiennojoho/1110.html | |
| 14 | `national-mushouka` | 幼児教育・保育の無償化 | https://www.cfa.go.jp/policies/kokoseido/mushouka | |
| 15 | `city-maruko` | 義務教育就学児医療費助成（マル子） | https://kosodate.city.hachioji.tokyo.jp/nenrei/sho_chugakusei/sodan_support/1085.html | |
| 16 | `city-marusei` | 高校生等医療費助成（マル青） | https://kosodate.city.hachioji.tokyo.jp/nenrei/kokoseiijo/2469.html | |
| 17 | `national-koko-shugaku-shien` | 高等学校等就学支援金 | https://www.mext.go.jp/a_menu/shotou/mushouka/index.htm | |

- 制度の ID は、情報源（`config/sources.seed.json`）の HTML ページの ID と同じです。
- 添付の PDF（`…-pdf`、`…-pdf1` など）は、関係する制度の原文抜粋に含まれて表示されます。PDF 単独では確認しません。
- 東京都福祉局の 4 件は、転載とディープリンクに許可が要るため、初回は登録していません（#54）。

## 3. 進み具合を見る

全制度の抜き出しの状態と、確認済みかどうかを一覧にします（`○` は抜き出せた項目、`－` は読み取れなかった項目）。

```bash
curl -s -X POST -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "Content-Type: application/json" "https://firestore.googleapis.com/v1/projects/$P/databases/(default)/documents:runQuery" -d '{"structuredQuery":{"from":[{"collectionId":"programs"}],"select":{"fields":[{"fieldPath":"eligibility"},{"fieldPath":"deadline"},{"fieldPath":"requiredDocs"},{"fieldPath":"verified"},{"fieldPath":"needsReview"}]}}}' | python3 -c '
import json,sys
for r in json.load(sys.stdin):
    d=r.get("document")
    if not d: continue
    f=d.get("fields",{}); has=lambda k: "○" if k in f and "nullValue" not in f[k] else "－"
    print(d["name"].split("/")[-1].ljust(34), "対象",has("eligibility"),"締切",has("deadline"),"書類",has("requiredDocs"),"確認済み" if f.get("verified",{}).get("booleanValue") else "", "要再確認" if f.get("needsReview",{}).get("booleanValue") else "")'
```

確認が済んだら、アプリ（https://hachioji-gov.web.app/home）を再読み込みし、世帯に合う制度が表示されることを確かめます。

## 4. 確認済みを取り消す

誤って確認済みにしたときは、取り消します（検索・表示の対象から外れます）。

```bash
npm run admin -- --project $P --operator "$ADMIN_UID" unverify <id>
```

## 5. 終わったら

#55 に、確認済みにした ID と、NG にした ID とその理由をコメントで残します。

```
確認済み: city-jido-teate, city-marunyu, ...
NG（確認済みにしなかった）:
- city-xxx: 対象の年齢が「中学生まで」と抜き出されているが、原文は「18歳まで」
```

## 困ったとき

| 表示 | 対処 |
|---|---|
| `admin クレームを持っていないため、操作を拒否しました` | ログイン中のアカウントが運営者ではない。[google-cloud-setup.md](google-cloud-setup.md) の手順7-2 で `grant-admin` する |
| `--operator <uid> … の指定が必要です` / `uid の長さ: 0` | 1 の uid の取得をやり直す |
| `表示した後に制度の内容が更新されました` | 確認中に収集が内容を更新した。同じコマンドをもう一度実行する |
| `原文抜粋がないため、確認できません` | 収集がまだ。収集ジョブの実行後に行う |
| `You do not currently have an active account selected` | `gcloud config set account <運営者のメールアドレス>` |
| `There was a problem refreshing your current auth tokens` | `gcloud auth login` を実行し、URL を開いて許可し、コードを貼る |
| `Could not load the default credentials` | 1 の ADC の作成をやり直す |
| `N/A: version "22 -> N/A" is not yet installed` | `nvm install 22 && nvm use 22` |
| `DeprecationWarning: module.register()` | 無視してよい |

## 注意

- 1 制度ずつ、原文を見てから `yes` を入力してください。
- 内容が変わった制度は、次の収集で自動的に「要再確認」（`needsReview`）になり、検索・表示から外れます。もう一度 `verify` してください。
- 表示されるコードやトークンは、チャットや Issue に貼らないでください。
