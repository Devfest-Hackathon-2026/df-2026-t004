# hachioji-gov Google Cloud セットアップ手順書

この手順書は、開発者本人が Google Cloud 側で手作業で行う設定をまとめたものです。課金アカウントの紐付け、ログイン、同意操作を含むため、AI や CI では代行できません。設計の詳細は `.kiro/specs/childcare-medical-welfare-navi/design.md` を参照してください。

> コマンドや画面は変更されることがあります。迷ったときは各手順末尾の公式ドキュメントで最新の内容を確認してください。シークレット（APIキー、パスワードなど）の値はこの文書にもリポジトリにも書かないでください。

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
- 予算アラートは「通知」であり、上限で自動停止はしません。20ドルを超えないよう、通知メールを必ず確認してください。
- 無料トライアルのクレジットがある場合、クレジット残高と有効期限を [課金のコンソール](https://console.cloud.google.com/billing) で確認してください。

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

3. 通知先メールを確認します。既定では課金管理者にメールが届きます。別のメールにも送る場合は、コンソールの「予算とアラート」で対象の予算を開き、通知チャネル（Cloud Monitoring のメールチャネル）を追加します。
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
4. Authentication → 設定 → 承認済みドメインに、公開するドメイン（`<PROJECT_ID>.web.app` など）を追加します。
5. Identity Platform へのアップグレードを求められる場合があります。無料枠の範囲内で使えるか、料金表を確認してから進めてください。
6. 確認: コンソールの Authentication → Users にテストユーザーが作れること。

公式: [Firebase Authentication](https://firebase.google.com/docs/auth)

## 5. Firestore の作成（東京リージョン）とインデックス（Requirement 9.8, 3, 5）

1. データベースを東京リージョンの Native モードで作成します。リージョンは後から変更できません。

```powershell
gcloud firestore databases create `
  --database="(default)" `
  --location=$REGION `
  --type=firestore-native
```

2. 確認

```powershell
gcloud firestore databases list
```

`locationId` が `asia-northeast1` であることを確認します。

3. ベクトルインデックスを作成します（`gemini-embedding-001` を 768 次元で使う設計）。次元を変える場合は、`vector-config` の `dimension` と `config/app.config.json` の `embeddingDimensions` を必ず同じ値にしてください。

```powershell
# ① 通常の RAG 検索用（自治体コード + 状態 + 年齢区分 + ベクトル）
gcloud firestore indexes composite create `
  --database="(default)" `
  --collection-group=chunks `
  --query-scope=COLLECTION `
  --field-config=order=ASCENDING,field-path=municipalityCode `
  --field-config=order=ASCENDING,field-path=status `
  --field-config=array-config=CONTAINS,field-path=ageBands `
  --field-config='field-path=embedding,vector-config={"dimension":"768","flat":"{}"}'

# ② 制度に限定した検索用（「AIに聞く」）
gcloud firestore indexes composite create `
  --database="(default)" `
  --collection-group=chunks `
  --query-scope=COLLECTION `
  --field-config=order=ASCENDING,field-path=programId `
  --field-config=order=ASCENDING,field-path=status `
  --field-config='field-path=embedding,vector-config={"dimension":"768","flat":"{}"}'
```

PowerShell で引用符の扱いが原因のエラーが出る場合は、`firebase/firestore.indexes.json` に定義して `firebase deploy --only firestore:indexes` で作成する方法か、コンソール（Firestore → インデックス → 手動 → ベクトルインデックスを作成）を使ってください。

4. インデックスの状態を確認します。作成には時間がかかり、`READY` になるまでベクトル検索は使えません。

```powershell
gcloud firestore indexes composite list --database="(default)"
```

5. Security Rules をデプロイします（`firebase/firestore.rules` を実装した後）。

```powershell
firebase deploy --only firestore:rules --project $PROJECT_ID
```

費用に関する注意: Firestore は読み取り・書き込み・保存量に応じた課金で、無料枠があります。ベクトル検索は読み取り課金が発生するため、検索結果の件数（最大5件）を増やさないでください。

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

# api: Firestore、Vertex AI、Firebase Auth 管理、FCM
foreach ($role in @("roles/datastore.user","roles/aiplatform.user","roles/firebaseauth.admin","roles/firebasemessaging.admin")) {
  gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$SA_API" --role=$role
}
# collector: Firestore、Vertex AI
foreach ($role in @("roles/datastore.user","roles/aiplatform.user")) {
  gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$SA_COLLECTOR" --role=$role
}
```

`sa-scheduler` への Job 実行権限は、手順9で Job を作成した後に付与します。確認:

```powershell
gcloud projects get-iam-policy $PROJECT_ID --flatten="bindings[].members" `
  --format="table(bindings.role,bindings.members)" --filter="bindings.members:sa-"
```

注意: `roles/owner` や `roles/editor` をサービスアカウントに付けないでください。

## 7. Secret Manager（Requirement 9.10）

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

Cloud Run へは、デプロイ時に `--set-secrets=ENV_NAME=<NAME>:latest` で環境変数として注入します（手順8）。確認:

```powershell
gcloud secrets list
```

値そのものを `echo` や `versions access` で画面やログに出さないでください。

## 8. Cloud Run（api）のデプロイ（Requirement 13.1）

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

## 9. Cloud Run Job（collector）と Cloud Scheduler（Requirement 3.1, 13.1）

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

費用に関する注意: 収集で変更があった情報源のみ Gemini（構造化抽出）と埋め込みを呼びます。登録する情報源を一度に増やしすぎると Vertex AI の費用が増えるため、最初は数件から始めてください。

## 10. Vertex AI のモデル有効化と確認（Requirement 9.5, 9.9）

1. `aiplatform.googleapis.com` は手順3で有効化済みです。
2. Vertex AI コンソールの Model Garden で、使うモデル（Gemini の生成用、`gemini-embedding-001`）を開き、利用規約への同意が求められる場合は同意します。
3. 東京リージョン（`asia-northeast1`）で使えるかを確認します。提供状況はモデルごとに異なり、変わることがあります。使えない場合は次のいずれかを選びます。
   - 東京で使える別のモデル名に `config/app.config.json` を変更する（コード変更は不要な設計）
   - 生成だけ別リージョンを使う場合は、プライバシー方針（個人情報を送らない設計）を踏まえて判断し、設計書に記録する
4. 疎通確認（アクセストークンを使った簡単な呼び出し例。モデル名は設定値に合わせる）

```powershell
$TOKEN = gcloud auth print-access-token
$body = '{"contents":[{"role":"user","parts":[{"text":"こんにちは"}]}]}'
Invoke-RestMethod -Method Post `
  -Uri "https://$REGION-aiplatform.googleapis.com/v1/projects/$PROJECT_ID/locations/$REGION/publishers/google/models/<生成モデル名>:generateContent" `
  -Headers @{ Authorization = "Bearer $TOKEN" } `
  -ContentType "application/json" -Body $body
```

5. プライバシー設定: プロンプトとレスポンスの追加ログ出力（リクエスト・レスポンスのログ）は有効にしないでください。画像や質問文が保存される経路を作らないためです。

公式: [Vertex AI の埋め込み](https://cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-text-embeddings)

## 11. Firebase Hosting と通知（任意）

```powershell
firebase init hosting --project $PROJECT_ID
# 公開ディレクトリ: packages/web/dist、SPA として設定: はい
firebase deploy --only hosting --project $PROJECT_ID
```

API への振り分け（`/api/**` を Cloud Run にリライトする場合）は `firebase.json` の `hosting.rewrites` に `run` で `serviceId` と `region` を指定します。

プッシュ通知（優先度「できれば」）を実装するときは、Firebase コンソールのプロジェクト設定 → Cloud Messaging で Web プッシュ証明書（VAPID キー）を生成します。公開鍵のみクライアントに置き、秘密鍵は Secret Manager で管理します。iPhone は、ホーム画面に追加した PWA のみ通知を受け取れます。

## 12. 設定値の控え（シークレットを除く）

次の表を自分のメモや `config/app.config.json` に控えます。シークレットの値は含めないでください。

| 項目 | 値の例 | 使う場所 |
| --- | --- | --- |
| プロジェクトID | `<PROJECT_ID>` | `app.config.json` の `gcp.projectId` |
| リージョン | `asia-northeast1` | `gcp.region`、`gcp.vertexLocation` |
| 生成モデル名 | 手順10で確認した名前 | `ai.generationModel` |
| 意図判定モデル名 | 同上 | `ai.intentModel` |
| 埋め込みモデル名 | `gemini-embedding-001` | `ai.embeddingModel` |
| 埋め込み次元 | `768` | `ai.embeddingDimensions`（インデックスの `dimension` と一致） |
| Cloud Run の URL | `gcloud run services describe` の結果 | Hosting のリライト、CORS 設定 |
| Firebase Web 設定 | `firebase apps:sdkconfig` の結果 | `packages/web` の `.env` |
| サービスアカウント | `sa-api` ほか | Cloud Run / Job の設定 |

## 13. 最終チェックリスト

- [ ] 課金アカウントが紐付き、予算（20 USD、50% / 80% / 100%）が表示される
- [ ] Firestore の `locationId` が `asia-northeast1`
- [ ] ベクトルインデックス2本が `READY`
- [ ] Authentication で Google とメール／パスワードが有効
- [ ] Cloud Run の `minScale` が 0、`max-instances` が設定済み
- [ ] Scheduler が毎日 03:00 JST に登録されている
- [ ] Secret Manager に値があり、ソースコードにシークレットがない
- [ ] Vertex AI のログ出力（プロンプトとレスポンス）を有効にしていない
- [ ] サービスアカウントに `owner` / `editor` を付けていない
- [ ] 不要になったとき: プロジェクトごと削除して課金を止められることを把握している（`gcloud projects delete $PROJECT_ID`。元に戻せないため注意）
