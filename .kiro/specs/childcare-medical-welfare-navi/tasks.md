# Implementation Plan: hachioji-gov（子育て世帯向け 医療・福祉情報ナビ）

## Overview

`requirements.md`（Requirement 1〜15）と `design.md` を実装するタスクリストである。言語は TypeScript（Node.js 22）、テストは Vitest と fast-check を使う。

進め方の原則:

- **セキュリティ関連のテストを最初に作る。** フェーズ0で、所有者以外のアクセス拒否の統合テスト、シークレット・個人情報のスキャン、依存パッケージの脆弱性検査、静的解析、CI を整えてから機能を実装する（Requirement 15）。
- **トップレベルのタスクごとに1つのブランチで作業する。** ブランチ名は `<type>/<短い説明>`（[commit-convention.md](../../../docs/commit-convention.md)）。各タスクの先頭に、ブランチ名、type、PR タイトルの例を書いた。
- **コミットメッセージは英語**で、commit-convention の type を使う。`main` へ直接コミットしない。
- **マージの条件:** CI の必須チェック（docs/github-setup.md の手順2の8つ）がすべて成功していること。
- **ユーザー作業は、このチェックボックスに含めない。** 開発者本人が行う作業（Google Cloud、GitHub の設定）は、末尾の「ユーザー作業」に `UW-` で始まる ID で一覧にした。AI は実行しない。AI のタスクに前提がある場合は「前提: UW-…」と書いた。
- 画像の読み取り・添付と F7（急な病気・けが）は MVP の対象外のため、タスクにしない。
- `*` が付いたサブタスクは任意（プロパティベーステストなど）。ただし、セキュリティ関連のテスト（所有者アクセス、ログ・PII、LLM に渡す情報、スキャン、脆弱性検査、静的解析）は必須のため `*` を付けない。

## Tasks

### フェーズ0: 足場・セキュリティテスト・CI

- [x] 1. モノレポの足場を作る
  - ブランチ: `build/monorepo-bootstrap` ／ type: `build` ／ PR タイトル例: `build: bootstrap TypeScript monorepo`
  - _Requirements: 13.6, 13.7, 15.5_
  - [x] 1.1 ルートの設定を作る
    - npm workspaces（`packages/shared`、`api`、`collector`、`admin`、`eval`、`web`）、Node.js 22 の指定（`.nvmrc`、`engines`）
    - `tsconfig.base.json`（`strict: true`）、各パッケージの `tsconfig.json`、ルートの `npm run typecheck`
    - ESLint（TypeScript、`eslint-plugin-security`）、Prettier、`npm run lint`
    - Vitest と fast-check（`numRuns` の既定を100以上にする共通設定）、`npm test`
    - 依存パッケージは固定バージョン（範囲指定なし）で追加する
    - _Requirements: 15.5_
  - [x] 1.2 空のパッケージを作る
    - 6つのパッケージに `package.json`、`src/index.ts`、`test/` を置き、型検査・lint・テストが通る最小の状態にする
    - `packages/shared` を他のパッケージから参照できるようにする
    - _Requirements: 13.6_
  - [x] 1.3 設定ファイルと `loadConfig` を作る
    - `config/app.config.json` の雛形（`region`、`ai.*Model`、`embedding.*`、`rag.*`、`limits.*`、`rateLimit.*`、`collector.*`）。モデル名はプレースホルダのまま（未確認事項 U-5）
    - `packages/shared` に zod スキーマと `loadConfig`。必須キーの欠落・空をすべてのキー名つきで報告して失敗する
    - _Requirements: 13.6, 13.7_
  - [x]* 1.4 `loadConfig` のプロパティテストを書く
    - **Property 39: 設定の検証**
    - **Validates: Requirements 13.6, 13.7**
  - [x] 1.5 Firebase Emulator の設定を作る
    - `firebase.json`（Firestore と Authentication の Emulator）、`firebase/firestore.rules`（初版は全拒否）、`firebase/firestore.indexes.json`（空）
    - `npm run test:integration` で Emulator を起動してテストを実行するスクリプト
    - _Requirements: 15.2_

- [x] 2. セキュリティテストの土台を作る
  - ブランチ: `security/ownership-and-log-tests` ／ type: `security` ／ PR タイトル例: `security: add ownership, rules and log redaction tests`
  - 機能を実装する前に、所有者以外のアクセスを拒否することと、ログに個人情報を出さないことを検査する仕組みを作る
  - _Requirements: 9.6, 9.7, 15.1, 15.2, 15.3_
  - [x] 2.1 `authorizeAccess` を実装する（`packages/shared`）
    - 認証済みで、トークンの `uid` とパスの `uid` が等しいときだけ許可する。未認証は 401、不一致は 403
    - _Requirements: 9.6, 9.7_
  - [x] 2.2 `authorizeAccess` のプロパティテストを書く（必須）
    - **Property 48: 所有者以外のアクセス拒否**
    - **Validates: Requirements 9.6, 9.7, 15.2**
  - [x] 2.3 Firestore Security Rules の初版とテストを作る
    - `users/{uid}/**` は本人のみ読み書き可。`sensitive` は API 経由のみ（クライアントからは書き込み不可）
    - `programs` は認証済みの読み取りのみ。`chunks`、`sources`、`fetchLogs`、`config`、`usage`、`usageUsers`、`deletionJobs` はクライアントから全拒否
    - `@firebase/rules-unit-testing` で、データ区分（世帯情報、子どもの情報、申請状況、医療費記録、チャット履歴）ごとに、本人は許可、他人と未認証は拒否、拒否後にデータが変わらないことを検査する
    - _Requirements: 9.6, 9.7, 15.2_
  - [x] 2.4 API の所有者検査の統合テストの雛形を作る（`packages/api`）
    - Emulator 上で、データ区分ごとに「他人の読み取り・書き込みは 403」「未認証は 401」「対象データは変わらない」を表形式で検査するテストのひな形とヘルパー（テスト用ユーザーの作成、ID トークンの取得）
    - エンドポイントの実装前は、ダミーのルートで動くことを確認し、エンドポイントを追加するたびに表へ1行足す運用にする
    - _Requirements: 15.1, 15.2_
  - [x] 2.5 ログの許可リスト `redactForLog` と構造化ロガーを作る（`packages/shared`）
    - 出力してよいキーは、リクエストID、ステータス、所要時間、エラー種別、件数だけ。例外メッセージにリクエストの内容が入っている場合も除去する
    - _Requirements: 15.3_
  - [x] 2.6 `redactForLog` のプロパティテストを書く（必須）
    - **Property 49: ログの許可リスト**
    - **Validates: Requirements 15.3**
  - [x] 2.7 ログ出力の個人情報スキャンを作る
    - テスト実行中のログを収集し、電話番号・メールアドレス・テストで使った質問文の本文・シークレットらしい文字列が含まれていないことを検査するスクリプトとテスト
    - _Requirements: 15.3_
  - [x] 2.8 gitleaks の設定を作る
    - `.gitleaks.toml`（既定ルール + テスト用ダミー値の許可）。ローカルで実行する npm スクリプト
    - _Requirements: 15.3_

- [x] 3. CI とリポジトリの保護を作る
  - ブランチ: `ci/add-security-workflows` ／ type: `ci` ／ PR タイトル例: `ci: add security and test workflows`
  - 前提: UW-GH-1（リポジトリで使える機能の確認）。この PR の後に UW-GH-3（ブランチ保護と必須チェックの登録）を行う
  - _Requirements: 15.1, 15.4, 15.5, 15.6, 15.7, 15.10, 15.11_
  - [x] 3.1 `.github/workflows/ci.yml` を作る
    - `pull_request`（opened、synchronize、reopened）と `main` への push で実行。`paths:` で絞らない
    - ジョブ名は docs/github-setup.md の手順2と一致させる: `static-analysis`（`tsc --noEmit`、ESLint）、`unit-and-property`（Vitest）、`integration-security`（Emulator の統合テストとログのスキャン）、`secret-scan`（gitleaks）、`dependency-audit`（`npm audit --audit-level=high --omit=dev`）、`codeql`、`index-consistency`、`pr-title`
    - 既定の権限は `contents: read`。`codeql` だけ `security-events: write`。サードパーティの Action はコミット SHA で固定する
    - `index-consistency` は、`gen-indexes` の実装前は「生成スクリプトがなければ成功」とし、実装後は再生成との差分を検査する
    - _Requirements: 15.1, 15.4, 15.5, 15.6, 15.11_
  - [x] 3.2 PR タイトルの検査を作る
    - `pr-title` ジョブで、PR タイトルが commit-convention の形式（`<type>(<scope>)!: <summary>`、type は一覧のもの、72文字以内）であることを検査する
    - _Requirements: 15.10_
  - [x] 3.3 Dependabot の設定を作る
    - `.github/dependabot.yml`: `npm`（ルート）と `github-actions` を週次で更新。コミットの接頭辞を `build(deps)` にして `pr-title` を通るようにする
    - _Requirements: 15.4_
  - [x] 3.4 PR・Issue テンプレートを作る
    - `.github/pull_request_template.md`（概要、type、テスト結果、シークレット・個人情報を含めていない確認、関連 Issue）
    - `.github/ISSUE_TEMPLATE/`（AI タスク、ユーザー作業、バグ報告）と `config.yml`
    - _Requirements: 15.9, 15.10_
  - [x] 3.5 開発ルールを README にまとめる
    - ブランチ運用、コミット規約、必須チェック、ローカルでの実行方法（typecheck、lint、test、test:integration、gitleaks）
    - _Requirements: 15.8, 15.9, 15.10_

- [x] 4. チェックポイント: フェーズ0 の確認
  - すべてのテストと CI の8つのジョブが成功することを確認する。問題があればユーザーに確認する

### フェーズ1: 共有の純粋ロジック（`packages/shared`）

- [ ] 5. 入力検証とオンボーディングのロジックを作る
  - ブランチ: `feat/shared-input-validation` ／ type: `feat` ／ PR タイトル例: `feat(shared): add input validation for auth and onboarding`
  - _Requirements: 1.3, 1.4, 2.1〜2.14, 9.1, 9.2, 11.7, 11.8_
  - [ ] 5.1 `validateEmail` と `validatePassword` を実装する
    - _Requirements: 1.3, 1.4_
  - [ ]* 5.2 メール・パスワード検証のプロパティテストを書く
    - **Property 1: メールアドレスとパスワードの検証**
    - **Validates: Requirements 1.3, 1.4**
  - [ ] 5.3 `classifyPostalCode` を実装する
    - 郵便番号表はテスト用の小さな表と、本番用の読み込み口を分ける
    - _Requirements: 2.1, 2.2, 2.3_
  - [ ]* 5.4 郵便番号の分類のプロパティテストを書く
    - **Property 3: 郵便番号の分類**
    - **Validates: Requirements 2.1, 2.2, 2.3**
  - [ ] 5.5 `validateChildren`、`validateFreeText`、`validateDueDate`、`validateHouseholdInput` を実装する
    - 人数0〜20、年齢0〜18（0歳は月齢0〜11）、自由記述200文字以内、出産予定日は入力日から10か月後の同日まで（存在しない日は月末）、人数0のときは出産予定日が必須
    - _Requirements: 2.4, 2.5, 2.8〜2.13, 11.7, 11.8_
  - [ ]* 5.6 入力検証のプロパティテストを書く
    - **Property 4: 子ども・自由記述の入力検証**
    - **Property 5: 世帯入力の必須項目**
    - **Property 7: 出産予定日の範囲**
    - **Validates: Requirements 2.4, 2.5, 2.8〜2.13, 11.7, 11.8**
  - [ ] 5.7 `splitByConsent` と `applyConsentWithdrawal`、`canReadSensitive` を実装する
    - 同意がなければ状況チップ・自由記述・出産予定日を保存ペイロードから除外する。削除に失敗した状態では読み出しを拒否する
    - _Requirements: 2.6, 2.7, 9.1〜9.4_
  - [ ] 5.8 同意のプロパティテストを書く（必須）
    - **Property 6: 同意による要配慮情報の分離**
    - **Property 50: 同意撤回後の要配慮情報**
    - **Validates: Requirements 2.6, 2.7, 9.1〜9.4**

- [ ] 6. 年齢区分・制度判定・表示のロジックを作る
  - ブランチ: `feat/shared-program-matching` ／ type: `feat` ／ PR タイトル例: `feat(shared): add age bands and program matching`
  - _Requirements: 2.7, 2.9, 2.14, 3.13〜3.16, 4.1〜4.10, 10.5, 10.6, 12.4_
  - [ ] 6.1 `estimateAge`、`ageToBand`、`deriveAgeBands` を実装する
    - _Requirements: 2.7, 2.9, 2.14, 9.3_
  - [ ]* 6.2 年齢区分のプロパティテストを書く
    - **Property 8: 推定年齢と年齢区分の変換**
    - **Property 9: 世帯の年齢区分の導出**
    - **Validates: Requirements 2.7, 2.9, 2.14, 3.4, 4.2, 9.3**
  - [ ] 6.3 `isSearchable`、`applyContentChange`、`applyVerification`、`canVerify` を実装する
    - _Requirements: 3.13〜3.16_
  - [ ]* 6.4 確認状態のプロパティテストを書く
    - **Property 15: 確認済みの制度だけが検索・表示の対象になる**
    - **Property 16: needsReview への遷移と再確認**
    - **Validates: Requirements 3.13, 3.14, 3.15, 4.1, 5.1**
  - [ ] 6.5 `canVerify` のプロパティテストを書く（必須）
    - **Property 17: 確認の権限**
    - **Validates: Requirements 3.16**
  - [ ] 6.6 `matchPrograms`、`filterByCategory`、`upcomingDeadlines`、`toProgramCard`、`toProgramView` を実装する
    - ラベルは常に「対象の可能性」。年齢区分が不明または未設定のものは除外せず「要確認」。締切超過は除外せず注意を付ける。カテゴリは判定の前に適用する
    - _Requirements: 4.1〜4.5, 4.8〜4.10, 10.5, 10.6_
  - [ ]* 6.7 制度判定と表示のプロパティテストを書く
    - **Property 10: 年齢区分「不明」と未設定の扱い**
    - **Property 18: ダッシュボードの候補判定**
    - **Property 19: Program_Card の整形**
    - **Property 20: 締切の並び替えと上限**
    - **Property 21: カテゴリ絞り込み**
    - **Property 35: 出典の表示モデル**
    - **Validates: Requirements 2.7, 4.1〜4.5, 4.8〜4.10, 5.1, 10.5, 10.6**
  - [ ] 6.8 `touchCache`（最大50件、最も長く開かれていないものを削除）を実装する
    - _Requirements: 12.4_
  - [ ]* 6.9 キャッシュのプロパティテストを書く
    - **Property 46: オフラインキャッシュの上限**
    - **Validates: Requirements 12.4**

- [x] 7. 収集のための純粋ロジックを作る
  - ブランチ: `feat/shared-collection-logic` ／ type: `feat` ／ PR タイトル例: `feat(shared): add pure logic for source collection`
  - _Requirements: 3.1〜3.12, 13.4, 13.5_
  - [x] 7.1 `isDue`、`decideSourceAction`、`planFetch` を実装する
    - _Requirements: 3.1, 3.2, 3.3, 3.6, 3.11, 3.12_
  - [x]* 7.2 取得判定のプロパティテストを書く
    - **Property 11: 取得の判定と置換の決定**
    - **Property 14: 取得上限**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.6, 3.11, 3.12**
  - [x] 7.3 `normalizeExtraction` と `chunkSource` を実装する
    - チャンクは原文抜粋のみで、AI の要約・言い換えを含めない。見出しまたはPDFページ、ハッシュ、年齢区分（読み取れなければ `unknown`）を付ける
    - _Requirements: 3.4, 3.7, 3.9, 3.10_
  - [x]* 7.4 抽出とチャンク化のプロパティテストを書く
    - **Property 12: 構造化情報の欠落の正規化**
    - **Property 13: チャンクは原文抜粋とメタデータで構成される**
    - **Validates: Requirements 3.4, 3.7, 3.9, 3.10**
  - [x] 7.5 `validateSourceRegistration` を実装する
    - _Requirements: 13.4, 13.5_
  - [x]* 7.6 情報源登録のプロパティテストを書く
    - **Property 40: 情報源登録の検証**
    - **Validates: Requirements 13.4, 13.5**

- [x] 8. 検索計画と、引用・根拠の検証ロジックを作る
  - ブランチ: `feat/shared-rag-logic` ／ type: `feat` ／ PR タイトル例: `feat(shared): add search planning and citation checks`
  - _Requirements: 4.7, 5.1〜5.3, 5.7, 5.9, 5.11〜5.13, 9.9, 9.13_
  - [x] 8.1 `planSearchQueries` と `mergeResults`、`l2Normalize` を実装する
    - フィルタは等価条件のみ（未確認事項 U-1）。年齢区分ごとの真偽値フィールド `band_*` を使い、クエリは21本以下
    - _Requirements: 4.7, 5.1_
  - [x]* 8.2 検索計画のプロパティテストを書く
    - **Property 24: 検索クエリ計画と直接フィルタの等価性**
    - **Property 25: 並列クエリ結果の統合**
    - **Property 41: 埋め込みの正規化**
    - **Validates: Requirements 4.7, 5.1**
  - [x] 8.3 `parseCitations`、`validateCitations`、`splitClaims`、`buildGroundingInputs`、`aggregateGrounding`、`nextChatAction` を実装する
    - 無効な引用は黙って削除しない。再生成は合計1回まで。失敗時の表示モデルは「根拠を確認できませんでした」、出典一覧、問い合わせ窓口で、回答本文を含めない
    - _Requirements: 5.2, 5.3, 5.11, 5.12, 5.13_
  - [x]* 8.4 引用・根拠のプロパティテストを書く
    - **Property 26: 引用番号の検証**
    - **Property 27: 再生成は合計1回までで、失敗時は fallback になる**
    - **Property 28: 根拠確認の純粋部分**
    - **Validates: Requirements 5.2, 5.3, 5.11, 5.12, 5.13, 14.4**
  - [x] 8.5 `validateQuestion`、`limitSuggestions` を実装する
    - _Requirements: 5.7, 5.9, 13.10_
  - [x]* 8.6 質問文と候補のプロパティテストを書く
    - **Property 22: 質問文の長さの検証**
    - **Property 23: 次の質問候補の上限**
    - **Validates: Requirements 5.7, 5.9, 13.10**
  - [x] 8.7 `buildLlmContext` と `maskPii` を実装する
    - LLM に渡す世帯の属性は自治体と年齢区分だけ。出産予定日と要配慮情報は渡さない。電話番号・メール・郵便番号は固定の置換文字列にする
    - _Requirements: 9.9, 9.13_
  - [x] 8.8 LLM に渡す情報のプロパティテストを書く（必須）
    - **Property 29: LLM に渡す世帯の属性**
    - **Property 30: 質問文の個人情報マスク**
    - **Validates: Requirements 9.9, 9.13**

- [ ] 9. 医療費・通知・アカウント削除のロジックを作る
  - ブランチ: `feat/shared-expense-logic` ／ type: `feat` ／ PR タイトル例: `feat(shared): add expense, notification and deletion logic`
  - _Requirements: 6.1〜6.5, 7.1, 7.6, 8.3, 8.5_
  - [ ] 9.1 `validateExpense`、`canSaveExpense`、`aggregateExpenses`、`suggestProgramsFromExpenses` を実装する
    - _Requirements: 6.1〜6.5_
  - [ ]* 9.2 医療費のプロパティテストを書く
    - **Property 31: 医療費記録の検証**
    - **Property 32: 医療費の集計**
    - **Property 33: 医療費からの制度の提示**
    - **Validates: Requirements 6.1〜6.5**
  - [ ] 9.3 `notificationTimes` と `cancelFor` を実装する（優先度「できれば」の通知で使う）
    - _Requirements: 7.1, 7.6_
  - [ ]* 9.4 通知計画のプロパティテストを書く
    - **Property 34: 通知の計画と取消**
    - **Validates: Requirements 7.1, 7.6**
  - [ ] 9.5 `planAccountDeletion` を実装する
    - 削除対象は `users/{uid}` 配下と、その `uid` の利用回数ドキュメントだけ。冪等にする
    - _Requirements: 8.3, 8.5_
  - [ ] 9.6 アカウント削除のプロパティテストを書く（必須）
    - **Property 47: アカウント削除の分離性と冪等性**
    - **Validates: Requirements 8.3, 8.5**

- [ ] 10. 日次上限・運営スイッチ・埋め込みの版管理・評価指標・変換のロジックを作る
  - ブランチ: `feat/shared-ops-and-eval-logic` ／ type: `feat` ／ PR タイトル例: `feat(shared): add quota, switch, reembed and eval logic`
  - _Requirements: 1.9, 1.10, 3.4, 6.1, 12.8, 13.8〜13.14, 14.1〜14.6_
  - [ ] 10.1 `evaluateRateLimit` を実装する
    - _Requirements: 1.9, 1.10_
  - [ ] 10.2 レート制限のプロパティテストを書く（必須）
    - **Property 2: レート制限**
    - **Validates: Requirements 1.9, 1.10**
  - [ ] 10.3 `dateKeyJst`、`evaluateQuota`、`resolveSwitch` を実装する
    - スイッチの読み取りに失敗してキャッシュが古いときは停止として扱う
    - _Requirements: 13.8, 13.9, 13.11, 13.12_
  - [ ]* 10.4 日次上限と運営スイッチのプロパティテストを書く
    - **Property 36: 日本時間の日付キー**
    - **Property 37: 日次上限**
    - **Property 38: 運営スイッチ**
    - **Validates: Requirements 13.8, 13.9, 13.11, 13.12**
  - [ ] 10.5 `planReembed` と `canCutover` を実装する
    - _Requirements: 13.13, 13.14_
  - [ ]* 10.6 埋め込み再生成のプロパティテストを書く
    - **Property 42: 埋め込み再生成の不変条件**
    - **Validates: Requirements 13.13, 13.14**
  - [ ] 10.7 `recallAtK`、`groundedRate`、`citationValidRate`、`percentile`、`validateEvalSet` を実装する
    - _Requirements: 12.8, 14.1〜14.5_
  - [ ]* 10.8 評価指標のプロパティテストを書く
    - **Property 43: 評価指標**
    - **Property 44: パーセンタイルの性質**
    - **Property 45: 評価セットの検証**
    - **Validates: Requirements 12.8, 14.1〜14.5**
  - [ ] 10.9 Program、Chunk、ExpenseRecord、EvalResult の `encode*` / `decode*` を実装する
    - _Requirements: 3.4, 6.1, 14.6_
  - [ ]* 10.10 変換のプロパティテストを書く
    - **Property 51: シリアライズのラウンドトリップ**
    - **Validates: Requirements 3.4, 6.1, 14.6**

- [ ] 11. チェックポイント: 共有ロジックの確認
  - すべてのテストと CI の必須チェックが成功することを確認する。問題があればユーザーに確認する
### フェーズ2: Firestore のルールとインデックス、収集、運営操作

- [ ] 12. Security Rules とインデックスの生成・検証を作る
  - ブランチ: `feat/firestore-rules-and-indexes` ／ type: `feat`（scope `infra`）／ PR タイトル例: `feat(infra): generate vector indexes and finalize rules`
  - _Requirements: 3.10, 4.7, 5.1, 9.6, 9.7, 13.13, 13.14, 15.2_
  - [ ] 12.1 `scripts/gen-indexes.ts` を作る
    - `config/app.config.json`（`embedding.fieldPrefix`、`dimensions`、`version`）から、1つの埋め込み版あたり17本の複合ベクトルインデックスを `firebase/firestore.indexes.json` に生成する。TTL などのフィールド設定も含める
    - CI の `index-consistency` を、再生成した結果とコミット済みファイルの差分検査に切り替える
    - _Requirements: 4.7, 5.1, 13.13_
  - [ ] 12.2 `scripts/verify-indexes.ts` を作る
    - `gcloud firestore indexes composite list --format=json` の出力を読み、次元・本数・`READY` を検査し、不一致があれば非ゼロで終了する。出力の読み込み部分は純粋関数にしてテストする
    - _Requirements: 13.14_
  - [ ] 12.3 Security Rules を完成させ、テストを追加する（必須）
    - `programs` の `verified*`・`needsReview`、`chunks.searchable`、`config/*` はクライアントから書き込み不可であることを、Rules のテストに追加する
    - _Requirements: 3.16, 9.6, 9.7, 15.2_
  - [ ] 12.4 等価条件のみのベクトル検索を Emulator で検証する
    - `findNearest` と等価条件の事前フィルタの組合せが Emulator で動くかを、統合テストで確認する。`in` や `array-contains` との併用可否も試し、結果を設計書の未確認事項 U-1 の確認記録として PR に書く（設計書は変更しない）。Emulator が対応していない場合は、その旨を記録し、実環境での確認を UW-GC-9 に回す
    - _Requirements: 4.7, 5.1_

- [ ] 13. 公的情報の収集ジョブを作る（`packages/collector`）
  - ブランチ: `feat/collector` ／ type: `feat` ／ PR タイトル例: `feat(collector): collect public sources into verified chunks`
  - 開発とテストは Emulator と差し替え可能な実装（`Fetcher`、`Embedder`、`Llm`、`VectorStore` のインメモリ実装）で行う。実環境での実行は UW-GC-7 の後
  - _Requirements: 3.1〜3.12, 3.15, 13.4, 13.11, 13.13_
  - [ ] 13.1 外部境界のインターフェースとインメモリ実装を作る
    - `Fetcher`（30秒タイムアウト）、`Embedder`、`Llm.extractProgram`、`VectorStore`、`Clock`、`OpsConfigStore` の型と、テスト用のインメモリ実装
    - _Requirements: 3.1, 3.5_
  - [ ] 13.2 HTML と PDF から本文と見出し・ページを取り出す処理を作る
    - 本文は要約せず原文のまま渡す。PDF はページ番号を保持する
    - _Requirements: 3.4, 3.9_
  - [ ] 13.3 収集の実行ループを作る
    - 開始時と各取得の直前に運営スイッチを確認する。`isDue` → 取得（再試行最大3回）→ `decideSourceAction` → 置換の順序（`needsReview` と旧チャンクの `searchable=false` → 新チャンクを `searchable=false` で書き込み → 旧チャンクを削除）を守る
    - 1つの情報源の失敗で他を止めない。失敗は `fetchLogs` に出典URL・時刻・原因（個人情報なし）を記録する。`planFetch` の上限と `deferred` の記録
    - 各チャンクに埋め込みのモデル名・次元・版を保存する
    - _Requirements: 3.1〜3.8, 3.11, 3.12, 3.15, 13.11, 13.13_
  - [ ] 13.4 Vertex AI の実装を作る
    - 埋め込み（`gemini-embedding-001`、出力次元は設定値、L2 正規化）と構造化抽出（JSON スキーマ、欠落は null）。モデル名とリージョンは設定から読む。リージョン指定のエンドポイントを使う
    - _Requirements: 3.3, 3.7, 13.6_
  - [ ] 13.5 Firestore 版の `VectorStore` の書き込みを実装する
    - `upsertChunks`（新チャンクを `searchable=false` で書き込んでから旧チャンクを削除する。バッチ書き込みの上限に合わせて分割する）、`setSearchable`（制度単位でチャンクの `searchable` を更新）、`markExcluded`（情報源単位で検索対象から外す）
    - フィールドは設計書の `chunks` スキーマ（`excerpt`、`emb_{version}`、`embeddingMeta`、`band_*`、`municipalityCode`、`category`、`programId`、`searchable` など）に合わせる
    - Emulator で統合テストを書く: 置換の途中で失敗しても、検索対象（`searchable=true`）に旧版と新版のチャンクが混ざらないこと。再実行しても同じ結果になること（冪等）
    - _Requirements: 3.3, 3.4, 3.6, 3.15, 13.13_
  - [ ]* 13.6 収集のユニットテストを書く
    - 取得失敗で既存チャンクが変わらないこと、1件の失敗で他が処理されること、404 が2回連続で除外されること、上限到達時の記録、運営スイッチが停止なら取得を始めないこと
    - _Requirements: 3.5, 3.6, 3.8, 3.12, 13.11_

- [ ] 14. 運営者の CLI を作る（`packages/admin`）
  - ブランチ: `feat/admin-cli` ／ type: `feat` ／ PR タイトル例: `feat(admin): add operator CLI for verification and switches`
  - 実環境での実行には UW-GC-12（運営者の資格情報と admin クレーム）が必要
  - _Requirements: 3.13〜3.16, 13.4, 13.5, 13.11, 13.14_
  - [ ] 14.1 `verify` と `unverify` を作る
    - 原文とハッシュを表示し、確認を対話で求めてから `applyVerification` を書き込み、該当チャンクを `searchable=true` にする。途中で失敗しても再実行で完了する
    - _Requirements: 3.13, 3.14, 3.15_
  - [ ] 14.2 `ops stop|start [ai|collection]` と `grant-admin <uid>` を作る
    - `grant-admin` はカスタムクレーム `admin` を付与する。操作対象のプロジェクトを必ず明示させる
    - _Requirements: 3.16, 13.11_
  - [ ] 14.3 `sources add` を作る
    - `validateSourceRegistration` で検証し、失敗時は既存の登録を変えずに欠落・無効な項目名を表示する
    - _Requirements: 13.4, 13.5_
  - [ ] 14.4 `reembed`（`--to`、`--verify`、`--cleanup`）と `embedding set-search-version` を作る
    - `planReembed` で対象を選び、原文抜粋から再生成する。`canCutover` が偽なら切り替えを拒否する。再生成中も既存の版で検索できる状態を保つ
    - _Requirements: 13.13, 13.14_
  - [ ] 14.5 初期の情報源リストの下書きと一括登録コマンドを作る
    - 八王子市（`13201`）・東京都（`13000`）・国（`00000`）の公開ページと PDF から、子育て支援、子どもの医療費助成、予防接種、妊娠・出産、外来・救急の案内に関するものを Web で調べ、`config/sources.seed.json` に下書きする（URL、`municipalityCode`、レベル、`html`／`pdf`、カテゴリ、取得間隔、確認状況を「未確認」）。1回の実行の取得上限（100ページ、1情報源あたり PDF 10件）に収まる件数にする
    - `sources import <file>` を作る。各行を `validateSourceRegistration` で検証し、登録済みの URL は飛ばす（冪等）。失敗した行と理由を一覧で表示し、既存の登録は変えない
    - 下書きの内容と各サイトの利用規約・robots.txt の確認、実環境への登録は運営者が行う（UW-GC-20）
    - _Requirements: 3.1, 13.4, 13.5_
  - [ ]* 14.6 CLI のユニットテストを書く
    - `admin` クレームのない主体の拒否、`verify` の冪等性、切り替えの拒否条件
    - _Requirements: 3.16, 13.14_

- [ ] 15. チェックポイント: 収集と運営操作の確認
  - すべてのテストと CI の必須チェックが成功することを確認する。問題があればユーザーに確認する

### フェーズ3: API と出典つき RAG、評価

- [ ] 16. API の基盤を作る（`packages/api`）
  - ブランチ: `feat/api-foundation` ／ type: `feat` ／ PR タイトル例: `feat(api): add auth, rate limit and quota middleware`
  - _Requirements: 1.9, 1.10, 9.6, 9.7, 9.10, 13.7〜13.12, 15.2, 15.3_
  - [ ] 16.1 Hono のアプリと共通ミドルウェアを作る
    - 順序: レート制限（IP）→ ID トークン検証 → レート制限（ユーザー）→ 認可（`authorizeAccess`）→ 構造化ログ（`redactForLog`）→ エラーハンドラ。超過時は 429 と `Retry-After`
    - `multipart/form-data`（画像）を受け付けるルートを作らない。起動時に `loadConfig` で検証する。シークレットは環境変数（Secret Manager から注入）からのみ読む
    - _Requirements: 1.9, 1.10, 9.5, 9.6, 9.7, 9.10, 13.7_
  - [ ] 16.2 運営スイッチと日次上限のストアを作る
    - `config/operations` を5秒キャッシュで読む。利用回数はトランザクションで全体とユーザー別を同時に判定・加算する。`expireAt` は Timestamp 型
    - _Requirements: 13.8, 13.9, 13.11, 13.12_
  - [ ] 16.3 所有者検査の統合テストを API に接続する（必須）
    - タスク 2.4 の雛形を実際のミドルウェアに接続し、401・403・データ不変を検査する。以降、エンドポイントを追加するたびに表へ行を足す
    - _Requirements: 9.7, 15.2_
  - [ ] 16.4 ミドルウェアのテストを書く（必須）
    - レート制限の 429、ログに質問文やメールが出ないこと（タスク 2.7 のスキャンを API のテストにも適用）
    - _Requirements: 1.10, 15.3_

- [ ] 17. 出典つき RAG チャットを作る
  - ブランチ: `feat/rag-chat` ／ type: `feat` ／ PR タイトル例: `feat(api): add grounded chat with citation checks`
  - 実環境での確認は UW-GC-7、UW-GC-9 の後
  - _Requirements: 4.7, 5.1〜5.14, 9.9, 9.13, 10.1〜10.3, 12.1〜12.3, 12.7, 13.10, 13.12_
  - [ ] 17.1 Firestore の `VectorStore.search` を実装する
    - `planSearchQueries` のクエリを並列に `findNearest`（`DOT_PRODUCT`、`minSimilarity`）で実行し、`mergeResults` で最大5件にする。検索に使う版は `config/embedding` の `searchVersion`
    - _Requirements: 4.7, 5.1, 5.14_
  - [ ] 17.2 Vertex AI の `Llm` 実装を作る
    - `streamAnswer`（最大出力トークン）、`judgeClaims`（JSON スキーマ）、`classifyIntent`。モデル名は設定から読み、リージョン指定のエンドポイントを使う。プロンプトに入る世帯の属性は `buildLlmContext` の出力だけにする
    - _Requirements: 9.9, 10.1, 13.6, 13.10_
  - [ ] 17.3 `POST /chat`（SSE）を作る
    - 受付直後に `status` を送る。文字数検証、運営スイッチ、日次上限、意図判定（診断・治療の判断は固定文で拒否）、`maskPii`、検索（0件なら LLM を呼ばず窓口を案内）、生成、引用検証、根拠確認、`nextChatAction` による `verified` / `reset` / `fallback`
    - チャット履歴に保存するのは確定した回答だけ。次の質問候補（最大3件）と、制度の提案（`proposal`）を返す。30秒以内に応答が始まらない場合はエラーにする
    - _Requirements: 5.1〜5.13, 9.13, 10.1〜10.3, 12.1, 12.3, 12.7, 13.12_
  - [ ] 17.4 チャットの所有者検査とログの検査を追加する（必須）
    - チャット履歴の他人アクセスの拒否を統合テストの表に追加する。チャットのリクエスト中に、質問文がログに出ないことを検査する
    - _Requirements: 9.7, 15.2, 15.3_
  - [ ]* 17.5 チャットのユニットテストを書く
    - 検索0件で LLM を呼ばないこと、診断依頼の拒否、無効な引用での再生成と fallback、上限到達時のメッセージ、ストリームの中断
    - _Requirements: 5.3, 5.4, 5.8, 5.12, 12.7, 13.12_

- [ ] 18. 評価ハーネスを作る（`packages/eval`）
  - ブランチ: `feat/eval-harness` ／ type: `feat` ／ PR タイトル例: `feat(eval): add retrieval and answer evaluation`
  - 評価セットの内容の確認は UW-GC-18
  - _Requirements: 12.8, 14.1〜14.8_
  - [ ] 18.1 評価セットのスキーマと初版を作る
    - 20問以上（答えのない質問3問以上）。各質問に期待する出典URL、含まれるべき事実、カテゴリ。`validateEvalSet` で検証する。初版は AI が下書きし、内容の確認は運営者が行う
    - _Requirements: 14.1, 14.2_
  - [ ] 18.2 `eval retrieval` と `eval answer` を作る
    - 検索の再現率@5、根拠範囲内率、引用の有効率を別々に計算し、実行日時、評価セットの版、モデル名、埋め込みの版とともに保存する
    - _Requirements: 14.3〜14.7_
  - [ ] 18.3 性能の計測コマンドを作る
    - 起動済みとコールドスタートのそれぞれで10回ずつ送信し、最初のテキスト断片までの時間の50・90パーセンタイルを記録する
    - _Requirements: 12.1, 12.2, 12.8_

- [ ] 19. チェックポイント: RAG と評価の確認
  - すべてのテストと CI の必須チェックが成功することを確認する。問題があればユーザーに確認する

### フェーズ4: 世帯・ダッシュボード・医療費・アカウント削除と画面

- [ ] 20. 世帯・ダッシュボード・医療費・アカウント削除の API を作る
  - ブランチ: `feat/api-household-and-expenses` ／ type: `feat` ／ PR タイトル例: `feat(api): add household, dashboard, expense and deletion APIs`
  - _Requirements: 2.1〜2.14, 4.1〜4.11, 6.1〜6.6, 8.3〜8.5, 9.1〜9.4, 9.11, 12.4_
  - [ ] 20.1 世帯情報・同意・郵便番号の API を作る
    - `GET/PUT /household`、`POST /consents/terms`、`POST /consents/sensitive`、`DELETE /consents/sensitive`（撤回と同時に削除。失敗時は `sensitiveLocked` で読み出しを拒否し、再試行できる）、`GET /postal/:code`
    - _Requirements: 2.1〜2.14, 9.1〜9.4, 9.11_
  - [ ] 20.2 ダッシュボード・制度・申請の API を作る
    - `GET /dashboard`（セクションごとに結果とエラー）、`GET /programs/:id`（確認済みのみ、`Cache-Control` と `X-Cached-At`）、`PUT /applications/:programId`
    - _Requirements: 4.1〜4.11, 12.4_
  - [ ] 20.3 医療費の API を作る
    - `POST/PUT/DELETE /expenses`、`GET /expenses/summary`（集計と制度の提示）。手入力のみ
    - _Requirements: 6.1〜6.6_
  - [ ] 20.4 アカウント削除の API を作る
    - `DELETE /account`: `deletionJobs/{uid}` を作り、`planAccountDeletion` の対象を削除してから Auth ユーザーを削除する。失敗時はサインイン状態を保ち、再試行できる
    - _Requirements: 8.3〜8.5_
  - [ ] 20.5 追加したエンドポイントの所有者検査を追加する（必須）
    - 世帯情報、子どもの情報、申請状況、医療費記録のそれぞれで、他人の読み書きが 403、未認証が 401、データ不変を統合テストの表に追加する。同意撤回の後に要配慮情報が読めないこと、アカウント削除が他のユーザーのデータを消さないことも検査する
    - _Requirements: 8.3, 9.3, 9.4, 9.7, 15.2_

- [ ] 21. PWA の土台を作る（`packages/web`）
  - ブランチ: `feat/web-foundation` ／ type: `feat` ／ PR タイトル例: `feat(web): add PWA shell with bottom tab bar`
  - _Requirements: 11.1〜11.6, 11.9, 12.4〜12.6_
  - [ ] 21.1 React と Vite の PWA を作る
    - `manifest.webmanifest`（`display: standalone`）、インストール案内（iOS は「ホーム画面に追加」の案内）
    - Workbox: 静的資産は Precache、`GET /programs/:id` は NetworkFirst（5秒）と最大50件。チャットの `POST` はキャッシュしない。オフライン時の表示（最新でない可能性、最後にキャッシュした時刻、未キャッシュは利用不可）
    - _Requirements: 11.2, 11.9, 12.4, 12.5, 12.6_
  - [ ] 21.2 画面の共通部品とアクセシビリティの土台を作る
    - 下部タブバー（ホーム、さがす、AI相談、マイホームの順に4つ。現在のタブは色以外でも示す）。タップ領域は44px以上、間隔8px以上。コントラストは本文4.5:1以上、大きな文字と部品の境界3:1以上。360〜430px で横スクロールしない
    - _Requirements: 11.1, 11.3, 11.4, 11.5, 11.6_

- [ ] 22. 登録・ログインとオンボーディングの画面を作る
  - ブランチ: `feat/web-auth-and-onboarding` ／ type: `feat` ／ PR タイトル例: `feat(web): add sign-up, sign-in and onboarding`
  - 実環境での確認は UW-GC-4 の後（開発中は Auth の Emulator を使う）
  - _Requirements: 1.1〜1.7, 2.1〜2.14, 9.1, 9.2, 9.11, 11.7, 11.8_
  - [ ] 22.1 登録・ログインの画面を作る
    - Firebase Authentication の SDK で直接登録・ログインする（独自のログイン API は作らない）。未認証ではダッシュボード・チャット・世帯データを表示しない。入力欄ごとのエラーと、登録済みかどうかを明かさないエラー文。利用規約とプライバシーポリシーへの明示的な同意（事前選択なし）がそろうまで登録できない
    - _Requirements: 1.1〜1.7, 9.11_
  - [ ] 22.2 オンボーディングの画面を作る
    - 必須は3項目（郵便番号、子どもの人数、年齢または出産予定日）。八王子市外の案内と国の制度のみで続ける選択肢、妊娠中の入力、「あとで入力する」、要配慮情報の同意ダイアログ（拒否時は保存しない）
    - _Requirements: 2.1〜2.14, 9.1, 9.2, 11.7, 11.8_

- [ ] 23. ダッシュボードと制度詳細の画面を作る
  - ブランチ: `feat/web-dashboard` ／ type: `feat` ／ PR タイトル例: `feat(web): add dashboard and program details`
  - _Requirements: 4.1〜4.11, 10.5, 10.6, 12.4〜12.6_
  - [ ] 23.1 ダッシュボードを作る
    - 3つのセクション（制度の候補、進行中の申請、締切）。カードに「対象の可能性」「要確認」「受付が終了している可能性があります」を表示する。カテゴリ絞り込み、該当なしの表示と解除、セクションごとのエラーと再試行
    - _Requirements: 4.1〜4.5, 4.8〜4.11_
  - [ ] 23.2 制度詳細を作る
    - 要点、手続きの流れ、必要なものチェックリスト、窓口、出典一覧（URL と取得日）、「最新の情報は窓口で確認を」の注意書き（出典が欠けていれば「出典未確認」）、「AIに聞く」、申請を進行中にする操作
    - _Requirements: 4.6, 4.7, 4.8, 10.5, 10.6_

- [ ] 24. AI 相談の画面を作る
  - ブランチ: `feat/web-chat` ／ type: `feat` ／ PR タイトル例: `feat(web): add grounded chat screen`
  - _Requirements: 5.2, 5.6, 5.7, 5.9, 5.10, 5.12, 9.14, 10.4, 12.1〜12.3, 12.7, 13.12_
  - [ ] 24.1 チャット画面を作る
    - 画面の上部に、閉じられない注意書き「診断や治療の判断は医師が行います」を、スクロールせずに見える位置に常時表示する（10.4）
    - 入力欄の近くに、閉じられない注意書き「氏名や病歴などの個人情報は入力しないでください」を常時表示し、500文字の上限と現在の文字数を表示する（9.14、5.9）
    - 画像の添付ボタンは作らない
    - _Requirements: 5.5, 5.9, 9.14, 10.4_
  - [ ] 24.2 ストリーミングの表示を作る
    - 送信から1秒以内に待機中の表示を出す。下書きは「根拠を確認中」と表示し、`reset` で置き換え、`fallback` では「根拠を確認できませんでした」、出典一覧、窓口を表示する。引用番号と出典一覧、次の質問候補のチップ、「ダッシュボードに追加」。中断時は途中までの回答を残し、再送信できる。上限到達・停止中のメッセージと再開時刻を表示し、質問文を保持する
    - _Requirements: 5.2, 5.6, 5.7, 5.10, 5.12, 12.1〜12.3, 12.7, 13.12_

- [ ] 25. 医療費・アカウント削除・同意撤回の画面を作る
  - ブランチ: `feat/web-expenses-and-account` ／ type: `feat` ／ PR タイトル例: `feat(web): add expenses, consent withdrawal and account deletion`
  - _Requirements: 6.1〜6.7, 8.3〜8.5, 9.3, 9.4_
  - [ ] 25.1 医療費の画面を作る
    - 手入力のフォーム（入力欄ごとのエラー、入力値の保持）、月別・年別・家族別の集計、制度の提示（対象の可能性、出典、不足している書類）、修正と、確認ダイアログつきの削除
    - _Requirements: 6.1〜6.7_
  - [ ] 25.2 アカウント削除と同意撤回の画面を作る
    - 元に戻せないことを示す確認ダイアログ、削除完了の表示とサインアウト、失敗時のエラーと再試行。同意撤回の完了確認と、失敗時の再試行
    - _Requirements: 8.3〜8.5, 9.3, 9.4_

- [ ] 26. チェックポイント: 画面の確認
  - すべてのテストと CI の必須チェックが成功することを確認する。問題があればユーザーに確認する
  - [ ]* 26.1 E2E とアクセシビリティのテストを書く
    - Playwright と axe-core で、360〜430px の横スクロール、タップ領域、コントラスト、タブバー、チャットの常設注意書き、オフラインの表示を検査する
    - _Requirements: 10.4, 11.1〜11.6, 12.5, 12.6_

### フェーズ5: 仕上げ

- [ ] 27. 利用規約とプライバシーポリシーを作る
  - ブランチ: `feat/legal-pages` ／ type: `feat` ／ PR タイトル例: `feat(web): add terms of service and privacy policy`
  - 文面は下書きであり、公開前に運営者が内容を確認する（法的な助言ではない）
  - _Requirements: 9.11, 9.12, 9.15_
  - [ ] 27.1 利用規約とプライバシーポリシーの画面を作る
    - 要配慮情報の利用目的と同意、ユーザーデータは東京リージョンに保存すること、認証情報は海外で処理される場合があること、質問文が外部 AI（Vertex AI）に送られること（個人情報のマスク後）と保持の可能性（UW-GC-7 の確認結果を反映）を記載する
    - _Requirements: 9.11, 9.12, 9.15_

- [ ] 28. デプロイの設定を作る
  - ブランチ: `build/deploy-config` ／ type: `build` ／ PR タイトル例: `build: add deploy configuration for Cloud Run and Hosting`
  - デプロイの実行は UW-GC-14、UW-GC-15（AI はデプロイしない）
  - _Requirements: 9.8, 13.1_
  - [ ] 28.1 API と収集ジョブのコンテナ設定を作る
    - `packages/api` と `packages/collector` の Dockerfile（非 root で実行、シークレットをイメージに含めない）、`.dockerignore`
    - _Requirements: 9.10, 13.1_
  - [ ] 28.2 Hosting の設定とデプロイ用の npm スクリプトを作る
    - `firebase.json` の Hosting（`packages/web/dist`、SPA、`/api/**` を Cloud Run の東京リージョンへリライト）。手順書のコマンドに対応する npm スクリプト（`min-instances=0`、`max-instances=3`）
    - _Requirements: 9.8, 13.1_

- [ ] 29. 締切の通知を作る（優先度: できれば）
  - ブランチ: `feat/deadline-notifications` ／ type: `feat` ／ PR タイトル例: `feat: add deadline notifications`
  - MVP の必須機能がすべて終わってから着手する
  - _Requirements: 7.1〜7.6_
  - [ ] 29.1 通知の API と配信を作る
    - `POST /devices`、7日前と1日前の通知（FCM）、送信失敗時に5分間隔で最大3回再試行し、失敗したらアプリ内のお知らせにする。申請の完了・制度の削除で通知を取り消す
    - _Requirements: 7.1, 7.5, 7.6_
  - [ ] 29.2 通知の画面を作る
    - 通知の許可、許可がない場合のアプリ内お知らせ、iPhone でホーム画面に追加していない場合の案内、保存した制度の更新のお知らせ
    - _Requirements: 7.2, 7.3, 7.4_
  - [ ] 29.3 通知の所有者検査を追加する（必須）
    - 端末トークンと通知の他人アクセスの拒否を統合テストの表に追加する
    - _Requirements: 9.7, 15.2_

- [ ] 30. 世帯情報の管理を作る（優先度: できれば）
  - ブランチ: `feat/household-management` ／ type: `feat` ／ PR タイトル例: `feat(web): add household management`
  - _Requirements: 8.1, 8.2, 11.8_
  - [ ] 30.1 マイホームで世帯情報を編集できるようにする
    - 保存後5秒以内におすすめを更新する。失敗時は以前の情報とおすすめを保ち、再試行できる。「あとで入力する」にした項目をここから編集できる
    - _Requirements: 8.1, 8.2, 11.8_

- [ ] 31. 最終チェックポイント
  - すべてのテストと CI の必須チェックが成功することを確認する。評価セットの結果と性能の計測結果を記録する。問題があればユーザーに確認する
  - _Requirements: 12.8, 14.6_

## ユーザー作業（開発者本人が行う。AI は実行しない）

課金、ログイン、同意、リポジトリの保護など、AI や CI が代行できない作業である。各作業は GitHub の Issue（ラベル `user-task`）として管理する。

### GitHub（[docs/github-setup.md](../../../docs/github-setup.md)）

| ID | 作業 | 手順書 | タイミング |
| --- | --- | --- | --- |
| UW-GH-1 | リポジトリの公開・非公開と、使える機能（ブランチ保護、CodeQL、Secret scanning）を確認する | 手順0 | タスク 3 の前 |
| UW-GH-2 | Actions の権限を読み取り専用にし、自動承認を無効にする | 手順3 | タスク 3 の前 |
| UW-GH-3 | `main` のブランチ保護と、8つの必須チェックを登録する | 手順1、手順2 | タスク 3 の PR で CI が一度動いた後、次の PR をマージする前 |
| UW-GH-4 | Dependabot alerts と security updates を有効にする | 手順5 | タスク 3 の後 |
| UW-GH-5 | Secret scanning と push protection を有効にする | 手順7 | できるだけ早く（タスク 1 の前が望ましい） |
| UW-GH-6 | CodeQL のデフォルトのセットアップが無効であることを確認する | 手順6 | タスク 3 の後 |

### Google Cloud（[docs/google-cloud-setup.md](../../../docs/google-cloud-setup.md)）

| ID | 作業 | 手順書 | タイミング |
| --- | --- | --- | --- |
| UW-GC-1 | ツールの準備、ログイン、プロジェクトの作成 | 手順0、手順1 | タスク 13 の前 |
| UW-GC-2 | 課金アカウントの紐付けと予算アラート（20 USD、50%・80%・100%） | 手順2 | UW-GC-1 の直後。Vertex AI を使う前 |
| UW-GC-3 | API の有効化 | 手順3 | UW-GC-2 の後 |
| UW-GC-4 | Firebase の追加と Authentication（Google、メール／パスワード）の有効化 | 手順4 | タスク 22 の実環境確認の前 |
| UW-GC-5 | Firestore（東京、Native）の作成 | 手順5-1 | UW-GC-3 の後 |
| UW-GC-6 | サービスアカウントの作成と最小権限の付与 | 手順6 | UW-GC-5 の後 |
| UW-GC-7 | Vertex AI のモデルの東京リージョンでの提供状況と、データ保持条件の確認（未確認事項 U-2、U-5）。確認したモデル名を `config/app.config.json` に入れる | 手順9 | タスク 13、17 の実環境確認の前 |
| UW-GC-8 | Secret Manager の登録（必要な場合のみ） | 手順8 | タスク 28 の前 |
| UW-GC-9 | インデックスのデプロイと `verify-indexes` の実行。実環境で等価条件のベクトル検索が動くことを確認する（U-1） | 手順5-2 | タスク 12 の後 |
| UW-GC-10 | Security Rules のデプロイ | 手順5-4 | タスク 12 の後 |
| UW-GC-11 | TTL ポリシー（`usage`、`usageUsers`、`deletionJobs` の `expireAt`）の設定 | 手順5-3 | タスク 16 の後 |
| UW-GC-12 | 運営者の資格情報（Application Default Credentials）と `admin` クレームの付与 | 手順7 | タスク 14 の後 |
| UW-GC-13 | 運営スイッチ（`config/operations`）と `config/embedding` の初期ドキュメントの作成 | 手順13 | タスク 14 の後（CLI がない間はコンソールで作成） |
| UW-GC-14 | Cloud Run（api）と Cloud Run Job（collector）、Cloud Scheduler のデプロイ | 手順10、手順11 | タスク 28 の後 |
| UW-GC-15 | Firebase Hosting のデプロイと、リライト経由のクライアント IP のヘッダー位置の確認（U-8） | 手順12 | タスク 28 の後 |
| UW-GC-16 | 収集する公的サイトの利用規約と robots.txt の確認（U-14） | 手順11 | タスク 13 を実環境で動かす前 |
| UW-GC-17 | 最初の20〜30制度の内容（対象・締切・必要書類）を確認し、`verify` で確認済みにする | 手順7（admin CLI） | UW-GC-20 と、実環境での収集の後 |
| UW-GC-18 | 評価セットの内容（期待する出典と事実）の確認 | — | タスク 18 の後 |
| UW-GC-19 | コスト見積もり（実測のトークン数で再計算し、日次上限を決める） | 手順14 | タスク 18 の後、公開の前 |
| UW-GC-20 | 初期の情報源リスト（`config/sources.seed.json`）の内容と、各サイトの利用規約・robots.txt を確認し、`sources import` で実環境に登録する | 手順7、手順11 | タスク 14、UW-GC-12、UW-GC-16 の後。UW-GC-17 の前 |

## Notes

- `*` が付いたサブタスクは任意で、MVP を早く作るために省略できる。ただし、セキュリティ関連のテスト（タスク 2、3、6.5、8.8、9.6、10.2、12.3、16.3、16.4、17.4、20.5、29.3）は必須である。
- 各プロパティテストは fast-check で100回以上実行し、テストにコメント `Feature: childcare-medical-welfare-navi, Property {番号}: {名前}` を付ける。
- 開発は Firebase Emulator とインメモリ実装で進め、実環境での確認は対応するユーザー作業の後に行う。
- 外部サービス（Vertex AI、Firebase Authentication、FCM）の応答品質や性能の目標（3秒、5秒、10秒）は、プロパティテストではなく、評価ハーネス（タスク 18）と実環境での計測で確認する。
- 設計書の未確認事項（U-1〜U-14）の確認結果は PR に記録する。設計の変更が必要になった場合は、`spec` の PR で設計書を直してから実装する。

## Task Dependency Graph

トップレベルのタスクごとにブランチを切って順番にマージするため、すべてのタスクを1つずつ順に実行する（同じ作業コピーで並列に実行すると、ブランチが衝突するため）。ユーザー作業（UW-）の前後関係は「ユーザー作業」の表を参照する。

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3"] },
    { "id": 3, "tasks": ["1.4"] },
    { "id": 4, "tasks": ["1.5"] },
    { "id": 5, "tasks": ["2.1"] },
    { "id": 6, "tasks": ["2.2"] },
    { "id": 7, "tasks": ["2.3"] },
    { "id": 8, "tasks": ["2.4"] },
    { "id": 9, "tasks": ["2.5"] },
    { "id": 10, "tasks": ["2.6"] },
    { "id": 11, "tasks": ["2.7"] },
    { "id": 12, "tasks": ["2.8"] },
    { "id": 13, "tasks": ["3.1"] },
    { "id": 14, "tasks": ["3.2"] },
    { "id": 15, "tasks": ["3.3"] },
    { "id": 16, "tasks": ["3.4"] },
    { "id": 17, "tasks": ["3.5"] },
    { "id": 18, "tasks": ["4"] },
    { "id": 19, "tasks": ["5.1"] },
    { "id": 20, "tasks": ["5.2"] },
    { "id": 21, "tasks": ["5.3"] },
    { "id": 22, "tasks": ["5.4"] },
    { "id": 23, "tasks": ["5.5"] },
    { "id": 24, "tasks": ["5.6"] },
    { "id": 25, "tasks": ["5.7"] },
    { "id": 26, "tasks": ["5.8"] },
    { "id": 27, "tasks": ["6.1"] },
    { "id": 28, "tasks": ["6.2"] },
    { "id": 29, "tasks": ["6.3"] },
    { "id": 30, "tasks": ["6.4"] },
    { "id": 31, "tasks": ["6.5"] },
    { "id": 32, "tasks": ["6.6"] },
    { "id": 33, "tasks": ["6.7"] },
    { "id": 34, "tasks": ["6.8"] },
    { "id": 35, "tasks": ["6.9"] },
    { "id": 36, "tasks": ["7.1"] },
    { "id": 37, "tasks": ["7.2"] },
    { "id": 38, "tasks": ["7.3"] },
    { "id": 39, "tasks": ["7.4"] },
    { "id": 40, "tasks": ["7.5"] },
    { "id": 41, "tasks": ["7.6"] },
    { "id": 42, "tasks": ["8.1"] },
    { "id": 43, "tasks": ["8.2"] },
    { "id": 44, "tasks": ["8.3"] },
    { "id": 45, "tasks": ["8.4"] },
    { "id": 46, "tasks": ["8.5"] },
    { "id": 47, "tasks": ["8.6"] },
    { "id": 48, "tasks": ["8.7"] },
    { "id": 49, "tasks": ["8.8"] },
    { "id": 50, "tasks": ["9.1"] },
    { "id": 51, "tasks": ["9.2"] },
    { "id": 52, "tasks": ["9.3"] },
    { "id": 53, "tasks": ["9.4"] },
    { "id": 54, "tasks": ["9.5"] },
    { "id": 55, "tasks": ["9.6"] },
    { "id": 56, "tasks": ["10.1"] },
    { "id": 57, "tasks": ["10.2"] },
    { "id": 58, "tasks": ["10.3"] },
    { "id": 59, "tasks": ["10.4"] },
    { "id": 60, "tasks": ["10.5"] },
    { "id": 61, "tasks": ["10.6"] },
    { "id": 62, "tasks": ["10.7"] },
    { "id": 63, "tasks": ["10.8"] },
    { "id": 64, "tasks": ["10.9"] },
    { "id": 65, "tasks": ["10.10"] },
    { "id": 66, "tasks": ["11"] },
    { "id": 67, "tasks": ["12.1"] },
    { "id": 68, "tasks": ["12.2"] },
    { "id": 69, "tasks": ["12.3"] },
    { "id": 70, "tasks": ["12.4"] },
    { "id": 71, "tasks": ["13.1"] },
    { "id": 72, "tasks": ["13.2"] },
    { "id": 73, "tasks": ["13.3"] },
    { "id": 74, "tasks": ["13.4"] },
    { "id": 75, "tasks": ["13.5"] },
    { "id": 76, "tasks": ["13.6"] },
    { "id": 77, "tasks": ["14.1"] },
    { "id": 78, "tasks": ["14.2"] },
    { "id": 79, "tasks": ["14.3"] },
    { "id": 80, "tasks": ["14.4"] },
    { "id": 81, "tasks": ["14.5"] },
    { "id": 82, "tasks": ["14.6"] },
    { "id": 83, "tasks": ["15"] },
    { "id": 84, "tasks": ["16.1"] },
    { "id": 85, "tasks": ["16.2"] },
    { "id": 86, "tasks": ["16.3"] },
    { "id": 87, "tasks": ["16.4"] },
    { "id": 88, "tasks": ["17.1"] },
    { "id": 89, "tasks": ["17.2"] },
    { "id": 90, "tasks": ["17.3"] },
    { "id": 91, "tasks": ["17.4"] },
    { "id": 92, "tasks": ["17.5"] },
    { "id": 93, "tasks": ["18.1"] },
    { "id": 94, "tasks": ["18.2"] },
    { "id": 95, "tasks": ["18.3"] },
    { "id": 96, "tasks": ["19"] },
    { "id": 97, "tasks": ["20.1"] },
    { "id": 98, "tasks": ["20.2"] },
    { "id": 99, "tasks": ["20.3"] },
    { "id": 100, "tasks": ["20.4"] },
    { "id": 101, "tasks": ["20.5"] },
    { "id": 102, "tasks": ["21.1"] },
    { "id": 103, "tasks": ["21.2"] },
    { "id": 104, "tasks": ["22.1"] },
    { "id": 105, "tasks": ["22.2"] },
    { "id": 106, "tasks": ["23.1"] },
    { "id": 107, "tasks": ["23.2"] },
    { "id": 108, "tasks": ["24.1"] },
    { "id": 109, "tasks": ["24.2"] },
    { "id": 110, "tasks": ["25.1"] },
    { "id": 111, "tasks": ["25.2"] },
    { "id": 112, "tasks": ["26.1"] },
    { "id": 113, "tasks": ["27.1"] },
    { "id": 114, "tasks": ["28.1"] },
    { "id": 115, "tasks": ["28.2"] },
    { "id": 116, "tasks": ["29.1"] },
    { "id": 117, "tasks": ["29.2"] },
    { "id": 118, "tasks": ["29.3"] },
    { "id": 119, "tasks": ["30.1"] },
    { "id": 120, "tasks": ["31"] }
  ]
}
```
