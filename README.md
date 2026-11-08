# hachioji-gov

八王子市の子育て世帯向けの、医療・福祉・子育て情報ナビ（スマホ向け PWA）です。国と自治体が公開している情報を集め、世帯に合う制度を出典つきで案内し、AI に相談できるようにします。

- 要件定義: [docs/hachiojigov.md](docs/hachiojigov.md)
- 仕様（Kiro）: [requirements](.kiro/specs/childcare-medical-welfare-navi/requirements.md) ／ [design](.kiro/specs/childcare-medical-welfare-navi/design.md) ／ [tasks](.kiro/specs/childcare-medical-welfare-navi/tasks.md)
- 手作業の設定: [GitHub](docs/github-setup.md) ／ [Google Cloud](docs/google-cloud-setup.md)

## リポジトリの構成

| 場所                     | 内容                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `packages/shared`        | 型・zod スキーマ・純粋関数（所有者検査 `authorizeAccess`、ログの許可リスト `redactForLog` など） |
| `packages/api`           | Cloud Run の API（Hono）                                                                         |
| `packages/collector`     | 公的情報の収集ジョブ（Cloud Run Job）                                                            |
| `packages/admin`         | 運営者の CLI                                                                                     |
| `packages/eval`          | 評価ハーネス・性能計測                                                                           |
| `packages/web`           | React PWA                                                                                        |
| `config/app.config.json` | モデル名・リージョン・各種上限（コードの外に置く設定）                                           |
| `firebase/`              | Firestore の Security Rules とインデックス                                                       |
| `scripts/`               | 開発用のスクリプト（ログの保存、PR タイトルの検査）                                              |

## 開発の準備

Node.js 22（`.nvmrc`）を使います。Emulator の統合テストには Java 21 以上が必要です。

```bash
npm ci
```

## ローカルでの実行

| コマンド                                  | 内容                                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                       | 全パッケージの型検査（`tsc --noEmit`、`strict`）                                                    |
| `npm run lint`                            | ESLint（`eslint-plugin-security` を含む）                                                           |
| `npm run format` / `npm run format:check` | Prettier で整形 ／ 整形の確認                                                                       |
| `npm test`                                | ユニットテストとプロパティベーステスト（Vitest + fast-check）                                       |
| `npm run test:integration`                | Firebase Emulator（Auth + Firestore）で統合テストを実行し、出力を `logs/test-output.log` に保存する |
| `npm run test:log-scan`                   | 保存したログに、電話番号・メール・郵便番号・シークレット・質問文のカナリアが無いことを検査する      |
| `npm run test:security`                   | `test:integration` と `test:log-scan` を続けて実行する                                              |
| `npm run secret-scan`                     | gitleaks でリポジトリの履歴全体を検査する（gitleaks v8.25 以上を別途インストール）                  |
| `npm run secret-scan:staged`              | gitleaks でコミット前のステージ済みの変更を検査する                                                 |

PR を出す前に、少なくとも `typecheck`・`lint`・`test` を通してください。Java と gitleaks が無い環境では、`test:security` と `secret-scan` は CI に任せて構いません。

## ブランチ運用

- `main` に直接コミット・プッシュしません。必ずブランチを切り、Pull Request でマージします。
- ブランチ名は `<type>/<短い説明>`（小文字、ハイフン区切り）。例: `feat/rag-chat`、`security/ownership-tests`
- tasks.md のタスク1つにつき Issue を1つ、ブランチを1つにします。Issue に書いたブランチ名を使います。
- マージの前に、下の必須チェックがすべて成功している必要があります。

## コミットと PR タイトルの規約

[docs/commit-convention.md](docs/commit-convention.md) に従います。要点:

- 1行目は `<type>(<scope>): <summary>`。英語、命令形、小文字で始め、末尾にピリオドを付けない。72文字以内
- type: `feat` `fix` `security` `docs` `spec` `test` `refactor` `perf` `style` `build` `ci` `chore` `revert`
- 破壊的変更は `feat(shared)!: …` とし、本文に `BREAKING CHANGE:` を書く
- 本文の末尾に `Refs #番号` または `Closes #番号`
- PR タイトルも同じ形式です（CI の `pr-title` が検査します）

## 必須チェック（CI）

PR では次の8つのチェックが実行され、すべて成功しないとマージできません（ブランチ保護の設定は [docs/github-setup.md](docs/github-setup.md) の手順1・2）。

| チェック名             | 内容                                                                                                 | ワークフロー   |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | -------------- |
| `static-analysis`      | 型検査、ESLint、Prettier                                                                             | `ci.yml`       |
| `unit-and-property`    | Vitest（ユニット + fast-check）                                                                      | `ci.yml`       |
| `integration-security` | Emulator での所有者以外のアクセス拒否・Security Rules のテストと、ログのスキャン                     | `ci.yml`       |
| `secret-scan`          | gitleaks（履歴全体）                                                                                 | `ci.yml`       |
| `dependency-audit`     | `npm audit --audit-level=high --omit=dev`（開発用の依存は警告のみ）                                  | `ci.yml`       |
| `codeql`               | CodeQL（JavaScript/TypeScript）。週1回の定期実行もある                                               | `ci.yml`       |
| `index-consistency`    | `gen-indexes` の出力とコミット済みの `firestore.indexes.json` の一致（生成スクリプトの実装前は成功） | `ci.yml`       |
| `pr-title`             | PR タイトルが規約の形式か                                                                            | `pr-title.yml` |

## セキュリティのルール

- シークレット（API キー、パスワード、トークン、サービスアカウントの鍵）はコミットしません。
- テストでは実在の個人情報を使わず、固定のダミー値（`test-user@example.com`、`090-0000-0000` など）を使います。これ以外の値は gitleaks で検出されます。
- ログは `createLogger`（`redactForLog` の許可リスト）だけで出します。質問文・世帯情報・LLM の入出力は出しません。
- `users/{uid}` を扱うルートを追加したら、`packages/api/src/routes.ts` の `OWNER_ROUTES` と、所有者検査のテスト表（`packages/api/test/ownership.integration.test.ts`）に1行ずつ足します。足し忘れると CI が失敗します。
- 依存パッケージは固定バージョン（範囲指定なし）で追加します。更新は Dependabot の PR で行います。
