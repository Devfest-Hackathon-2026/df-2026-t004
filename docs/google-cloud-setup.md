# hachioji-gov Google Cloud セットアップ手順書

この手順書は、開発者本人が Google Cloud 側で手作業で行う設定をまとめたものです。課金アカウントの紐付け、ログイン、同意操作を含むため、AI や CI では代行できません。設計の詳細は `.kiro/specs/childcare-medical-welfare-navi/design.md` を参照してください。GitHub 側の作業は [github-setup.md](./github-setup.md) にあります。

> コマンドや画面は変更されることがあります。迷ったときは各手順末尾の公式ドキュメントで最新の内容を確認してください。確認できていない点は「要確認」と書いています。シークレット（APIキー、パスワードなど）の値はこの文書にもリポジトリにも書かないでください。

## 実装前の段階についての注意

この手順書は実装より先に書かれています。次のものは、実装が終わるまで存在しません。該当する手順には「未実装」と注記しています。

| 未実装のもの | 設計書での場所 | 影響する手順 |
| --- | --- | --- |
| `scripts/gen-indexes.ts` | リポジトリ構成 | 手順5（インデックス作成） |
| `scripts/verify-indexes.ts` | 埋め込みの版管理と再生成 | 手順5（インデックス検証） |
| `packages/admin`（admin CLI） | 運営による確認と管理操作 | 手順6、手順7、手順13（運営スイッチ、管理者クレーム） |
| `packages/api`、`packages/collector` | リポジトリ構成 | 手順10、手順11 |

admin CLI のコマンド名は設計書の記載（`ops stop|start`、`grant-admin`、`verify` など）に従っています。実際の起動方法（例: npm スクリプト名）は実装時に決まるため、この文書の `admin ...` は実装後に読み替えてください。

## 0. 前提

- Google アカウント（個人用でよい）
- クレジットカードなどの支払い方法（無料トライアルのクレジットを使う場合も登録が必要になることがある）
- 次のツール（PowerShell で確認）

```powershell
# Google Cloud CLI
gcloud --version
# Firebase CLI
firebase --version
# Node.js 22 以上
node --version
```

未インストールの場合は、[Google Cloud CLI](https://cloud.google.com/sdk/docs/install) と `npm install -g firebase-tools` で入れます。

- 以降のコマンドで使う変数（PowerShell）。`<...>` は自分の値に置き換えます。

```powershell
$PROJECT_ID = "<hachioji-gov-xxxxx>"   # グローバルで一意。後から変更できない
$REGION     = "asia-northeast1"        # 東京
$BILLING_ID = "<XXXXXX-XXXXXX-XXXXXX>" # 課金アカウントID（手順2で確認）
```

## 1. ログインとプロジェクト作成

1. CLI にログインします。

```powershell
gcloud auth login
firebase login
```

2. プロジェクトを作成して、既定にします。

```powershell
gcloud projects create $PROJECT_ID --name="hachioji-gov"
gcloud config set project $PROJECT_ID
gcloud config set run/region $REGION
```

3. 確認

```powershell
gcloud config list
```

`project` と `run/region` が意図した値であることを確認します。

## 2. 課金アカウントの紐付けと予算アラート（Requirement 13.1〜13.3）

費用に関する注意:
- この構成は使用量課金です。Cloud Run、Firestore、Cloud Scheduler、Secret Manager、Firebase Hosting には無料枠があります。主な費用は Vertex AI（Gemini の生成・埋め込み）です。
- **予算アラートは「通知」だけです。上限に達しても自動では停止しません。** 20ドルは保証ではなく設計目標です。アラートを受け取ったら、手順13の対応手順に従って自分で AI を停止してください。
- 無料トライアルのクレジットがある場合、クレジット残高と有効期限を [課金のコンソール](https://console.cloud.google.com/billing) で確認してください。
- 運営を始める前に、手順14の「コスト見積もり」を済ませてください。

1. 課金アカウントIDを確認して紐付けます。

```powershell
gcloud billing accounts list
gcloud billing projects link $PROJECT_ID --billing-account=$BILLING_ID
```

2. 予算を作成します（20 USD、50% / 80% / 100% で通知）。

```powershell
gcloud services enable billingbudgets.googleapis.com
gcloud billing budgets create `
  --billing-account=$BILLING_ID `
  --display-name="hachioji-gov-budget" `
  --budget-amount=20USD `
  --filter-projects="projects/$PROJECT_ID" `
  --threshold-rule=percent=0.5 `
  --threshold-rule=percent=0.8 `
  --threshold-rule=percent=1.0
```

3. 通知先メールを確認します。既定では課金管理者にメールが届きます。別のメールにも送る場合は、コンソールの「予算とアラート」で対象の予算を開き、通知チャネル（Cloud Monitoring のメールチャネル）を追加します。メールが迷惑メールに入らないことも確認してください。
4. 確認

```powershell
gcloud billing budgets list --billing-account=$BILLING_ID
```

予算が表示され、しきい値が3つあることを確認します。控え: 課金アカウントID（機密ではないが公開リポジトリには書かない）。

公式: [予算とアラートの設定](https://cloud.google.com/billing/docs/how-to/budgets)

## 3. API の有効化

```powershell
gcloud services enable `
  firestore.googleapis.com `
  run.googleapis.com `
  cloudbuild.googleapis.com `
  artifactregistry.googleapis.com `
  cloudscheduler.googleapis.com `
  secretmanager.googleapis.com `
  aiplatform.googleapis.com `
  identitytoolkit.googleapis.com `
  firebase.googleapis.com `
  firebasehosting.googleapis.com `
  fcm.googleapis.com `
  iam.googleapis.com
```

確認:

```powershell
gcloud services list --enabled
```

## 4. Firebase の追加と Authentication（Requirement 1）

1. 既存の Google Cloud プロジェクトに Firebase を追加します。

```powershell
firebase projects:addfirebase $PROJECT_ID
```

2. Web アプリを登録し、設定値（`firebaseConfig`）を控えます。

```powershell
firebase apps:create WEB "hachioji-gov-web" --project $PROJECT_ID
firebase apps:sdkconfig WEB --project $PROJECT_ID
```

`apiKey` などの Web 用設定は公開されても問題ない識別子ですが、`.env` に入れて管理します（サーバー用のシークレットとは別物です）。

3. Firebase コンソール（Authentication → Sign-in method）で、手作業で次を有効にします。
   - Google
   - メール／パスワード

   登録とログインは、アプリのクライアントが Firebase Authentication の SDK で直接行います。独自のログイン API やカスタムトークンの発行は作りません。ブルートフォース対策は Firebase 標準のものをそのまま使うため、無効にする設定をしないでください（Requirement 1.8）。
4. Authentication → 設定 → 承認済みドメインに、公開するドメイン（`<PROJECT_ID>.web.app` など）を追加します。
5. Identity Platform へのアップグレードを求められる場合があります。無料枠の範囲内で使えるか、料金表を確認してから進めてください。
6. 確認: コンソールの Authentication → Users にテストユーザーが作れること。

### Authentication の処理場所についての注意（要確認）

設計書の調査では、Firebase の[場所の一覧](https://firebase.google.com/docs/projects/locations)に Authentication の場所指定が載っていませんでした。Authentication の認証情報（メールアドレス、認証ID）は、**東京ではなく海外で処理される可能性があります**。設計書の未確認事項 U-4 です。

- 手順の最後に、公式ドキュメント（Firebase のデータ処理に関する記載）を読み直し、最新の扱いを確認してください。
- 確認した結果にかかわらず、プライバシーポリシーには「認証情報は海外で処理される可能性がある」と書きます（断定はしません）。
- 「ユーザーデータは東京リージョンに保存する」と説明してよいのは Firestore のデータだけです。

公式: [Firebase Authentication](https://firebase.google.com/docs/auth)

## 5. Firestore の作成（東京リージョン）とインデックス（Requirement 9.8, 3, 5, 13.14）

### 5-1. データベースの作成

データベースを東京リージョンの Native モードで作成します。リージョンは後から変更できません。

```powershell
gcloud firestore databases create `
  --database="(default)" `
  --location=$REGION `
  --type=firestore-native
```

確認:

```powershell
gcloud firestore databases list
```

`locationId` が `asia-northeast1` であることを確認します。

### 5-2. ベクトルインデックス（等価条件のみの構成）

設計書の「検索設計」では、ベクトル検索の事前フィルタを**等価条件（`==`）だけ**にしています。`array-contains` や `in` と併用できるかを公式ドキュメントで確認できなかった（設計書 U-1）ためです。そのため、インデックスは次の構成になります。

| 種別 | フィールド（すべて等価条件 + ベクトル） | 本数 |
| --- | --- | --- |
| 年齢区分あり | `municipalityCode`, `searchable`, `band_X`, ベクトル | 7 |
| 年齢区分あり + カテゴリ | 上記 + `category` | 7 |
| 年齢区分なし | `municipalityCode`, `searchable`, ベクトル | 1 |
| 年齢区分なし + カテゴリ | 上記 + `category` | 1 |
| 制度限定 | `programId`, `searchable`, ベクトル | 1 |
| 合計（1つの埋め込み版あたり） | | **17** |

- `band_X` は、年齢区分ごとの真偽値フィールドです（`band_pregnancy`、`band_age_0_2`、`band_age_3_5`、`band_age_6_11`、`band_age_12_14`、`band_age_15_18`、`band_unknown` の7種）。配列フィールドは使いません。
- ベクトルのフィールド名は版ごとに別です（例: `emb_v1`）。次元は `config/app.config.json` の `embedding.dimensions`（既定 768）です。
- 埋め込みの版を切り替える移行中は、新しい版のインデックスが17本追加され、合計34本になります。複合インデックス数の上限は未確認です（設計書 U-3）。公式の割り当てと制限のページで確認してください。

**gcloud でインデックスを1本ずつ作成しないでください。** 設計書では、`scripts/gen-indexes.ts` が `config/app.config.json` から `firebase/firestore.indexes.json` を生成し、それをデプロイする方針です。手で書くと設定とのずれが起きます。

> **未実装の注記:** `scripts/gen-indexes.ts` と `scripts/verify-indexes.ts` は、まだ存在しません（実装前）。実装が終わるまで、この手順 5-2 以降は実行できません。実行方法（例: `npx tsx scripts/gen-indexes.ts`）は実装時に決まるので、実装後の README に合わせてください。

実装後の手順:

1. 設定とインデックス定義を生成します（要確認: 起動コマンドは実装後に確定）。

```powershell
npx tsx scripts/gen-indexes.ts
```

2. 生成された `firebase/firestore.indexes.json` の内容を確認します。`chunks` 向けのベクトルインデックスが17本あり、`dimension` が設定値（768）であることを見ます。
3. `firebase.json` の `firestore.indexes` が `firebase/firestore.indexes.json` を指していることを確認します（要確認: パスは実装時に設定）。
4. デプロイします。

```powershell
firebase deploy --only firestore:indexes --project $PROJECT_ID
```

5. 状態を確認します。作成には時間がかかり、すべて `READY` になるまでベクトル検索は使えません。

```powershell
gcloud firestore indexes composite list --database="(default)"
# 状態だけを見やすく表示する場合（要確認: フォーマット式は gcloud のバージョンで変わることがある）
gcloud firestore indexes composite list --database="(default)" --format="table(name,state)"
```

   `state` が `CREATING` のものは、しばらく待って再実行します。17本すべてが `READY` になることを確認します。

6. 設定とインデックスの一致を検証します（要確認: 起動コマンドは実装後に確定）。

```powershell
npx tsx scripts/verify-indexes.ts
```

   `verify-indexes` は、内部で `gcloud firestore indexes composite list --format=json` を読み、①`embedding.dimensions` と各ベクトルインデックスの `dimension` の一致、②17本の期待する構成が揃っていること、③状態が `READY` であること、を検査します。不一致があると非ゼロで終了します。失敗したときは、`config/app.config.json` を直すか、`gen-indexes` を再実行して再デプロイします。

   `gen-indexes` の出力とコミット済みの `firestore.indexes.json` が一致することは、CI の `index-consistency` ジョブでも検査されます。

次元を変える場合は、設計書の「埋め込みの版管理と再生成」の手順（収集を停止 → 新しい版のインデックスを作成 → `reembed` → 検証 → 切り替え）に従ってください。`dimension` と `embedding.dimensions` を必ず同じ値にします。

### 5-3. TTL ポリシー（利用回数などの自動削除）

設計書では、古い利用回数ドキュメントと削除ジョブを、Firestore の TTL ポリシーで自動削除します（Requirement 13）。対象は次の3つのコレクショングループで、フィールドは `expireAt` です。

| コレクショングループ | 内容 |
| --- | --- |
| `usage` | 全体の日次AI呼び出し回数 |
| `usageUsers` | ユーザー別の日次AI呼び出し回数 |
| `deletionJobs` | アカウント削除の進行状態 |

```powershell
gcloud firestore fields ttls update expireAt --collection-group=usage --enable-ttl
gcloud firestore fields ttls update expireAt --collection-group=usageUsers --enable-ttl
gcloud firestore fields ttls update expireAt --collection-group=deletionJobs --enable-ttl
```

- ポリシーが有効になるまでに10分以上かかることがあります。`--async` を付けると完了を待ちません。
- 確認:

```powershell
gcloud firestore fields ttls list
gcloud firestore operations list
```

- **注意（設計書との確認事項）:** TTL に使うフィールドは、Firestore の「日時（Timestamp）型」である必要があります。文字列などの別の型では、そのドキュメントの TTL は効きません。設計書のデータモデルでは `expireAt` が `string` と書かれているため、実装時に Timestamp 型で保存することを確認してください。
- 画面で行う場合: Google Cloud コンソール → Firestore → データベース → 「Time-to-live」 → 「ポリシーを作成」。

公式: [Firestore の TTL](https://firebase.google.com/docs/firestore/ttl)

### 5-4. Security Rules のデプロイ

`firebase/firestore.rules` を実装した後に行います。

```powershell
firebase deploy --only firestore:rules --project $PROJECT_ID
```

`programs` の確認状態、`chunks.searchable`、`config/*`、`sources`、`usage*` はクライアントから書き込めない設計です。デプロイ後、Emulator のテスト（CI の `integration-security`）が通っていることを確認してください。

費用に関する注意: Firestore は読み取り・書き込み・保存量に応じた課金で、無料枠があります。ベクトル検索は並列クエリ（最大21本、各5件）になるため、読み取り課金に注意してください。検索結果の件数（最大5件）やクエリ本数の上限を増やさないでください。

公式: [Firestore ベクトル検索](https://firebase.google.com/docs/firestore/vector-search)

## 6. サービスアカウントと権限（最小権限）（Requirement 9.6）

用途ごとにサービスアカウントを分けます。

```powershell
gcloud iam service-accounts create sa-api       --display-name="hachioji-gov api"
gcloud iam service-accounts create sa-collector --display-name="hachioji-gov collector"
gcloud iam service-accounts create sa-scheduler --display-name="hachioji-gov scheduler invoker"

$SA_API       = "sa-api@$PROJECT_ID.iam.gserviceaccount.com"
$SA_COLLECTOR = "sa-collector@$PROJECT_ID.iam.gserviceaccount.com"
$SA_SCHEDULER = "sa-scheduler@$PROJECT_ID.iam.gserviceaccount.com"

# api: Firestore、Vertex AI、Firebase Auth 管理（ID トークン検証・アカウント削除）、FCM
foreach ($role in @("roles/datastore.user","roles/aiplatform.user","roles/firebaseauth.admin","roles/firebasemessaging.admin")) {
  gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$SA_API" --role=$role
}
# collector: Firestore、Vertex AI
foreach ($role in @("roles/datastore.user","roles/aiplatform.user")) {
  gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$SA_COLLECTOR" --role=$role
}
```

`sa-scheduler` への Job 実行権限は、手順11で Job を作成した後に付与します。確認:

```powershell
gcloud projects get-iam-policy $PROJECT_ID --flatten="bindings[].members" `
  --format="table(bindings.role,bindings.members)" --filter="bindings.members:sa-"
```

注意: `roles/owner` や `roles/editor` をサービスアカウントに付けないでください。

## 7. 運営者の資格情報と管理者クレーム（Requirement 3.16）

制度の確認（`verify`）、運営スイッチ（`ops`）、再生成（`reembed`）などの運営操作は、`packages/admin` の CLI が Admin SDK で行います。管理画面は作りません。そのため、CLI を動かす開発者本人のローカル環境の資格情報が必要です。

### 7-1. 運営者の資格情報（Application Default Credentials）

```powershell
gcloud auth application-default login
gcloud auth application-default set-quota-project $PROJECT_ID
```

- 資格情報はローカルに保存されます。共有パソコンでは使わず、運営作業が終わったら必要に応じて `gcloud auth application-default revoke` で無効にします。
- この資格情報の主体（自分の Google アカウント）には、Firestore への書き込み権限が必要です。個人のアカウントがプロジェクトのオーナーであれば足ります。権限を絞る場合は、`roles/datastore.user` と Firebase Authentication の管理権限（カスタムクレーム付与用）を付けます（要確認: 付与するロール名は `grant-admin` の実装時に確認）。
- CLI は、必ず対象のプロジェクトを明示して実行してください（本番とは別の開発用プロジェクトを作る場合の取り違えを防ぐため）。

### 7-2. 管理者カスタムクレーム（`admin`）の付与

`admin` クレームを持つ主体だけが、制度の確認などの管理操作の認可を通ります（`canVerify`）。付与は admin CLI の `grant-admin` で行います。

1. 自分のアカウントでアプリにサインインして、`uid` を確認します（Firebase コンソール → Authentication → Users の「ユーザー UID」）。
2. 付与します。

```powershell
# 要確認: 実際の起動方法は packages/admin の実装後に確定
admin grant-admin <自分のUID>
```

> **未実装の注記:** `packages/admin` はまだ存在しません。実装が終わるまでこの手順は実行できません。

3. クレームはトークンに含まれます。付与後は、いったんサインアウトして再度サインインし、新しいトークンを取得してください。
4. 確認: 管理者のみが通る操作（例: `verify` の実行）が成功し、管理者でないアカウントでは拒否されること。
5. 注意: クレームはクライアントのトークンにも入るため、権限の判断は必ずサーバー側で検証します。運営者のアカウントには必ず2段階認証を有効にしてください。

公式: [カスタムクレーム](https://firebase.google.com/docs/auth/admin/custom-claims)

## 8. Secret Manager（Requirement 9.10）

シークレットの値はコマンド履歴やファイルに残さないように、標準入力から登録します。このMVPで扱う可能性のあるシークレットの例は、メール送信用キーなど外部サービスの鍵です。Vertex AI と Firestore はサービスアカウントで認証するため、APIキーは不要です。

```powershell
# シークレットの作成（値は対話的に入力。<NAME> は例: EXAMPLE_API_KEY）
gcloud secrets create <NAME> --replication-policy=automatic
Read-Host "値を入力" -AsSecureString | ConvertFrom-SecureString -AsPlainText | gcloud secrets versions add <NAME> --data-file=-

# api のサービスアカウントに参照権限を付与
gcloud secrets add-iam-policy-binding <NAME> `
  --member="serviceAccount:$SA_API" `
  --role="roles/secretmanager.secretAccessor"
```

Cloud Run へは、デプロイ時に `--set-secrets=ENV_NAME=<NAME>:latest` で環境変数として注入します（手順10）。確認:

```powershell
gcloud secrets list
```

値そのものを `echo` や `versions access` で画面やログに出さないでください。

## 9. Vertex AI のモデル有効化とデータ保持条件の確認（Requirement 9.5, 9.9, 9.15）

### 9-1. モデルの有効化と東京リージョンでの確認

1. `aiplatform.googleapis.com` は手順3で有効化済みです。
2. Vertex AI コンソールの Model Garden で、使うモデル（Gemini の生成用、`gemini-embedding-001`）を開き、利用規約への同意が求められる場合は同意します。
3. 東京リージョン（`asia-northeast1`）で使えるかを確認します。提供状況はモデルごとに異なり、変わることがあります（設計書 U-5）。使えない場合は次のいずれかを選びます。
   - 東京で使える別のモデル名に `config/app.config.json` を変更する（コード変更は不要な設計）
   - 生成だけ別リージョンを使う場合は、プライバシー方針（個人情報を送らない設計）を踏まえて判断し、設計書とプライバシーポリシーに記録する
4. 疎通確認（モデル名は `config/app.config.json` の値に合わせる）。**リージョン指定のエンドポイント**（`https://asia-northeast1-aiplatform.googleapis.com`）を使います。

```powershell
$TOKEN = gcloud auth print-access-token
$body = '{"contents":[{"role":"user","parts":[{"text":"こんにちは"}]}]}'
Invoke-RestMethod -Method Post `
  -Uri "https://$REGION-aiplatform.googleapis.com/v1/projects/$PROJECT_ID/locations/$REGION/publishers/google/models/<生成モデル名>:generateContent" `
  -Headers @{ Authorization = "Bearer $TOKEN" } `
  -ContentType "application/json" -Body $body
```

### 9-2. データ保持条件の確認（ゼロデータ保持を前提にしない）

設計書では、Vertex AI の**ゼロデータ保持を前提にしません**。公式ドキュメントの記載は次のとおりです（設計時点の確認内容。最新は必ず公式を読んでください）。

- 顧客データでモデルを学習しません。
- 不正利用の監視のため、プロンプトがログとして保持される場合があります。ゼロデータ保持には、例外の申請が必要と記載されています。
- 暗黙のキャッシュ（メモリ内と永続）は既定で有効で、書き込みから24時間以内に削除されます。
- リージョン指定のエンドポイントでは、永続キャッシュが指定したロケーション内に留まります。グローバルエンドポイントでは、任意のリージョンで処理されうるため、**グローバルエンドポイントは使いません**。
- リクエスト・レスポンスのログは既定で無効です。

公式（必ず読む）: [Vertex AI とゼロデータ保持](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/vertex-ai-zero-data-retention)

確認する作業:

1. 上記の公式ページを開き、使うモデルごとのデータ保持と処理場所の記載が設計書の内容と変わっていないか確認します（設計書 U-2）。変わっていたら設計書とプライバシーポリシーに反映します。
2. **リクエスト・レスポンスのログを有効にしません。** これを有効にすると、質問文やモデルの出力が BigQuery などに保存されます。誤って有効にしていないかを、Vertex AI のコンソールの設定とプロジェクトのログの出力先（Cloud Logging のシンクや BigQuery のデータセット）で確認してください（要確認: コンソール上の設定項目の名前は画面の変更で変わることがあります）。
3. キャッシュの設定を確認します。設定の確認には `roles/aiplatform.viewer`、`roles/aiplatform.user`、`roles/aiplatform.admin` のいずれかが必要です。

```powershell
$TOKEN = gcloud auth application-default print-access-token
Invoke-RestMethod -Method Get `
  -Uri "https://us-central1-aiplatform.googleapis.com/v1/projects/$PROJECT_ID/cacheConfig" `
  -Headers @{ Authorization = "Bearer $TOKEN" }
```

   応答の見方:
   - `retentionType` が `DURABLE`: メモリ内と永続のキャッシュが両方有効（既定）
   - `retentionType` が `EPHEMERAL`: 永続キャッシュは無効、メモリ内キャッシュは有効
   - `disableCache` が `true`: キャッシュはすべて無効

   （公式の例では、設定用のエンドポイントとして `us-central1` が使われています。設定は全リージョンに適用されるとされています。要確認: 最新の公式ページのエンドポイント）

4. キャッシュを無効にするかを決めます（任意）。キャッシュを止めると、保存される可能性のあるデータは減りますが、応答が遅くなったり費用が増えたりする可能性があります。この判断は運営者が行い、結果をプライバシーポリシーに反映します。無効にする場合は、`roles/aiplatform.admin` が必要です。

```powershell
# 永続キャッシュだけを無効にする（メモリ内キャッシュは残る）
$body = '{"name":"projects/' + $PROJECT_ID + '/cacheConfig","disableCache":false,"retentionConfig":{"retentionType":"EPHEMERAL"}}'
Invoke-RestMethod -Method Patch `
  -Uri "https://us-central1-aiplatform.googleapis.com/v1/projects/$PROJECT_ID/cacheConfig" `
  -Headers @{ Authorization = "Bearer $TOKEN" } `
  -ContentType "application/json" -Body $body

# キャッシュをすべて無効にする場合は、本文を {"name":"projects/<PROJECT_ID>/cacheConfig","disableCache":true} にする
```

5. 確認結果を控え、プライバシーポリシーに「外部の生成AIへ質問文が送られること」「保持される可能性があること」を明記します。

## 10. Cloud Run（api）のデプロイ（Requirement 13.1）

リポジトリに `packages/api` を実装した後に行います。`--min-instances=0` が重要です（待機コストをゼロにする）。

```powershell
gcloud run deploy hachioji-gov-api `
  --source=packages/api `
  --region=$REGION `
  --service-account=$SA_API `
  --min-instances=0 `
  --max-instances=3 `
  --memory=512Mi `
  --timeout=300 `
  --allow-unauthenticated `
  --set-env-vars=APP_CONFIG_PATH=config/app.config.json
  # シークレットがある場合は --set-secrets=ENV_NAME=<NAME>:latest を追加
```

- `--allow-unauthenticated` は、API 自身が Firebase の ID トークンを検証して認可するための設定です（ブラウザから呼べるようにするため）。認証なしで通るエンドポイントは作らないでください。
- `--max-instances=3` は、想定外のアクセスによる課金の暴走を抑えるための上限です。
- 確認

```powershell
gcloud run services describe hachioji-gov-api --region=$REGION `
  --format="value(status.url,spec.template.metadata.annotations)"
```

`minScale` が `0`、リージョンが `asia-northeast1` であることを確認します。

## 11. Cloud Run Job（collector）と Cloud Scheduler（Requirement 3.1, 13.1）

```powershell
# Job の作成（リトライは Job 側で 1 回まで。取得リトライはアプリ側で 3 回行う）
gcloud run jobs deploy hachioji-gov-collector `
  --source=packages/collector `
  --region=$REGION `
  --service-account=$SA_COLLECTOR `
  --memory=1Gi `
  --task-timeout=900 `
  --max-retries=1

# Scheduler の起動用アカウントに Job 実行権限を付与
gcloud run jobs add-iam-policy-binding hachioji-gov-collector `
  --region=$REGION `
  --member="serviceAccount:$SA_SCHEDULER" `
  --role="roles/run.invoker"

# 毎日 03:00 JST に実行
gcloud scheduler jobs create http hachioji-gov-collector-daily `
  --location=$REGION `
  --schedule="0 3 * * *" `
  --time-zone="Asia/Tokyo" `
  --uri="https://$REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$PROJECT_ID/jobs/hachioji-gov-collector:run" `
  --http-method=POST `
  --oauth-service-account-email=$SA_SCHEDULER
```

確認と手動実行:

```powershell
gcloud scheduler jobs list --location=$REGION
gcloud run jobs execute hachioji-gov-collector --region=$REGION
```

費用に関する注意: 収集で変更があった情報源のみ Gemini（構造化抽出）と埋め込みを呼びます。登録する情報源を一度に増やしすぎると Vertex AI の費用が増えるため、最初は数件から始めてください。1回の実行あたり100ページ、1情報源あたりPDF 10件までの上限が設計されています。

収集の前に、各公的サイトの利用規約と robots.txt を確認してください（設計書 U-14）。

## 12. Firebase Hosting と通知（任意）

```powershell
firebase init hosting --project $PROJECT_ID
# 公開ディレクトリ: packages/web/dist、SPA として設定: はい
firebase deploy --only hosting --project $PROJECT_ID
```

API への振り分け（`/api/**` を Cloud Run にリライトする場合）は `firebase.json` の `hosting.rewrites` に `run` で `serviceId` と `region` を指定します。リライト経由のクライアント IP の取得位置は未確認です（設計書 U-8）。実環境でヘッダーを確認してください。

プッシュ通知（優先度「できれば」）を実装するときは、Firebase コンソールのプロジェクト設定 → Cloud Messaging で Web プッシュ証明書（VAPID キー）を生成します。公開鍵のみクライアントに置き、秘密鍵は Secret Manager で管理します。iPhone は、ホーム画面に追加した PWA のみ通知を受け取れます。

## 13. 運営スイッチと予算アラートへの対応（Requirement 13.3, 13.11）

### 13-1. 運営スイッチ（`config/operations`）とは

`config/operations` ドキュメントの `aiEnabled` と `collectionEnabled` で、AI 相談と収集を止められます。

```
{ aiEnabled: boolean, collectionEnabled: boolean, updatedAt, updatedBy }
```

- API は 5 秒のメモリキャッシュで読み、切り替えから 10 秒以内に反映されます。
- 読み取りに失敗してキャッシュが古くなった場合は、安全側（停止）として扱われます。
- クライアントからは読み書きできません。書き込みは admin CLI（または Firebase コンソールからの直接編集）だけです。

### 13-2. 初期ドキュメントの作成

運営開始前に、`config/operations` と `config/embedding` の初期ドキュメントを作ります。

1. admin CLI で作る方法（実装後。**未実装**）:

```powershell
# 要確認: 起動方法・引数は packages/admin の実装後に確定
admin ops start ai
admin ops start collection
admin embedding set-search-version v1
```

2. Firebase コンソールから手作業で作る方法（admin CLI が使えるようになるまで）: Firestore → データ → コレクション `config` → ドキュメントID `operations` → フィールド `aiEnabled`（boolean）、`collectionEnabled`（boolean）、`updatedAt`（timestamp または設計書の型に合わせる）、`updatedBy`（string）を追加します。`config/embedding` には `searchVersion`（string、値 `v1`）を追加します。（要確認: 型は実装時に設計書のデータモデルに合わせる）

初期値は、動作確認ができるまで `aiEnabled: false`、`collectionEnabled: false` にしておくと安全です。

### 13-3. 日常の操作

```powershell
# 要確認: 起動方法は実装後に確定。コマンド名は設計書に従う
admin ops stop ai            # AI 相談を停止
admin ops start ai           # AI 相談を再開
admin ops stop collection    # 収集を停止
admin ops start collection   # 収集を再開
```

- 停止すると、AI 相談は「運営により一時停止中」の表示（理由と窓口）になり、収集は新規の取得を開始しません。
- 管理画面は作りません。CLI が使えない緊急時は、Firebase コンソールで `config/operations` を直接編集して、`aiEnabled` を `false` にしてください。

### 13-4. 予算アラートを受け取ったときの対応

**予算アラートは自動停止しません。** メールを受け取ったら、しきい値ごとに次のように対応します。

| 通知 | 実際の使用額の目安（20 USD の予算） | 対応 |
| --- | --- | --- |
| 50% | 約 10 USD | [課金のコンソール](https://console.cloud.google.com/billing)でサービス別の内訳を確認する。残りの日数で 20 USD に収まるか見積もりを更新する。必要なら `limits.globalPerDay` を下げる |
| 80% | 約 16 USD | 原因（Vertex AI の生成・埋め込み、Firestore の読み取りなど）を特定する。超過が見込まれるなら `admin ops stop ai` で AI を止める |
| 100% | 約 20 USD | **直ちに `admin ops stop ai` と `admin ops stop collection` を実行する。** 止まったことを確認し、原因を調べてから再開する |

手順:

1. メールの通知を開き、どの予算かを確認する。
2. 課金のコンソール → レポートで、プロジェクト、サービス、日別にグループ化して原因を探す。
3. AI を止める（上のコマンド、または Firebase コンソールで `aiEnabled` を `false`）。
4. 停止後、数十分〜数時間は課金が反映されないことがあるため、翌日にもう一度コンソールを確認する。
5. 再開の判断は、原因の対策（上限値の引き下げ、収集対象の見直しなど）をしてから行う。

アラートの通知は遅れて届くことがあり、実際の費用はそれより多い場合があります。20 ドルは保証ではなく設計目標です。通知を待たず、手順14の見積もりと、日次上限（ユーザー1人あたり 20 回/日、全体 500 回/日）で費用を抑えてください。

## 14. コスト見積もり（運営開始前の作業）（Requirement 13）

運営を始める前に、日次上限と費用の見積もりを必ず行います。設計書の式を使います。

```
LLM費用 = 質問総数 × (入力トークン × 入力単価 + 出力トークン × 出力単価) × 補正係数
質問総数 = 利用人数 × 1人あたりの1日の質問数 × 運用日数
補正係数 = 1 + 再生成率 + 根拠判定の入力比 ＋ 意図判定の入力比
合計 = LLM費用 + 埋め込み費用(収集時) + Firestore 読み書き + その他
```

作業:

1. 使う生成モデル・判定モデル・埋め込みモデルの**最新の単価**を、公式の料金ページで確認します（設計書 U-7）。
   - [Vertex AI の料金](https://cloud.google.com/vertex-ai/generative-ai/pricing)
   - [Firestore の料金](https://cloud.google.com/firestore/pricing)
   - [Cloud Run の料金](https://cloud.google.com/run/pricing)
2. 1質問あたりのトークン数を決めます。設計書の仮の値は、生成（入力3,000・出力600）、根拠判定（入力2,000・出力200）、意図判定（入力500・出力20）、再生成率10%を加味して、入力約5,800・出力約870です。評価ハーネス（`eval answer`）を作ったら、実測値に置き換えます。
3. 次の計算を、単価を自分で入れて実行します（PowerShell。単価の値は書かずに、実行時に入れます）。

```powershell
$inUnit  = [double](Read-Host "入力単価（USD / 100万トークン）")
$outUnit = [double](Read-Host "出力単価（USD / 100万トークン）")
$inTok   = 5800      # 1質問あたりの入力トークン（補正後。評価後に実測値へ）
$outTok  = 870       # 1質問あたりの出力トークン（同上）
$perQ    = $inTok * $inUnit / 1e6 + $outTok * $outUnit / 1e6
"1質問あたり: {0:N5} USD" -f $perQ
"20 USD に収まる質問総数（LLMのみ）: {0:N0}" -f (20 / $perQ)

$users = 20; $perDay = 3; $days = 30
"想定利用の費用: {0:N2} USD" -f ($users * $perDay * $days * $perQ)

$globalPerDay = 500
"全体の日次上限を毎日使い切った場合（{0}日）: {1:N2} USD" -f $days, ($globalPerDay * $days * $perQ)
```

4. 結果を見て、次を判断します。
   - 全体の日次上限を毎日使い切った場合の費用が 20 USD を超えるなら、`limits.globalPerDay`（`config/app.config.json`）を下げるか、試作の運用日数を短くします。設計書の仮の例では、500回/日を30日続けると 20 ドルを超えます。日次上限は暴走を抑える天井であり、予算の保証ではありません。
   - 想定利用の見積もりが予算に近いなら、日次上限を想定利用に近づけます。
5. 収集の埋め込み費用も見積もります。初回の埋め込みと、版を切り替えるときの再生成（全チャンク分）に費用がかかります。チャンク数 × 1チャンクあたりのトークン数 × 埋め込みの単価で概算します。
6. 見積もりの結果（日付、単価の出典、仮定）を自分のメモに残します。設計書 U-7 のとおり、料金は変わるため、運営開始前と、モデルを変えたときに再計算します。

## 15. 設定値の控え（シークレットを除く）

次の表を自分のメモや `config/app.config.json` に控えます。シークレットの値は含めないでください。

| 項目 | 値の例 | 使う場所 |
| --- | --- | --- |
| プロジェクトID | `<PROJECT_ID>` | gcloud / firebase の `--project`（設計書の設定ファイルに項目はない。要確認: アプリ側で必要な場合は環境変数など） |
| リージョン | `asia-northeast1` | `region`、`ai.location` |
| 生成モデル名 | 手順9で確認した名前 | `ai.generationModel` |
| 根拠判定モデル名 | 同上 | `ai.judgeModel` |
| 意図判定モデル名 | 同上 | `ai.intentModel` |
| 埋め込みモデル名 | `gemini-embedding-001` | `embedding.model` |
| 埋め込み次元 | `768` | `embedding.dimensions`（インデックスの `dimension` と一致） |
| 埋め込みの版 | `v1` | `embedding.version`、`config/embedding` の `searchVersion` |
| 日次上限 | ユーザー 20 / 全体 500 | `limits.perUserPerDay`、`limits.globalPerDay`（手順14の結果で調整） |
| Cloud Run の URL | `gcloud run services describe` の結果 | Hosting のリライト、CORS 設定 |
| Firebase Web 設定 | `firebase apps:sdkconfig` の結果 | `packages/web` の `.env` |
| サービスアカウント | `sa-api` ほか | Cloud Run / Job の設定 |

## 16. 最終チェックリスト

- [ ] 課金アカウントが紐付き、予算（20 USD、50% / 80% / 100%）が表示される
- [ ] 予算アラートが自動停止ではないこと、受信時の対応手順（手順13-4）を理解している
- [ ] Firestore の `locationId` が `asia-northeast1`
- [ ] ベクトルインデックス17本が `READY`（`gen-indexes` が生成した `firestore.indexes.json` を `firebase deploy --only firestore:indexes` で作成した。実装後）
- [ ] `verify-indexes` が成功する（実装後）
- [ ] TTL ポリシー（`usage`、`usageUsers`、`deletionJobs` の `expireAt`）が作成され、フィールドが Timestamp 型である
- [ ] Authentication で Google とメール／パスワードが有効。独自ログイン API を作っていない
- [ ] Authentication が海外で処理される可能性を、プライバシーポリシーに書いた
- [ ] Vertex AI のデータ保持条件を公式で確認し、ゼロデータ保持を前提にしていない。リクエスト・レスポンスのログを有効にしていない。キャッシュ設定を確認した
- [ ] リージョン指定のエンドポイントを使っている（グローバルエンドポイントを使っていない）
- [ ] 運営者の資格情報（`gcloud auth application-default login`）を設定した
- [ ] `grant-admin` で `admin` クレームを自分に付与した（実装後）
- [ ] `config/operations` と `config/embedding` の初期ドキュメントがある。`ops stop ai` で AI を止められることを確認した（実装後）
- [ ] コスト見積もり（手順14）を済ませ、日次上限を決めた
- [ ] Cloud Run の `minScale` が 0、`max-instances` が設定済み
- [ ] Scheduler が毎日 03:00 JST に登録されている
- [ ] Secret Manager に値があり、ソースコードにシークレットがない
- [ ] サービスアカウントに `owner` / `editor` を付けていない
- [ ] 不要になったとき: プロジェクトごと削除して課金を止められることを把握している（`gcloud projects delete $PROJECT_ID`。元に戻せないため注意）
