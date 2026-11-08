# コミットメッセージ規約

hachioji-gov のコミットメッセージは、この規約に従って書きます。ブランチ運用とPRの流れも、このドキュメントで統一します。

## 基本ルール

- コミットメッセージは英語で書きます（このドキュメントなど、読み物は日本語です）。
- 1行目は `<type>(<scope>): <summary>` の形式にします。`scope` は省略できます。
- `summary` は、命令形の現在形で書き、先頭を小文字にし、末尾にピリオドを付けません。
- 1行目は72文字以内にします。
- 変更の理由が分かりにくいときは、1行空けて本文に「なぜ」を書きます。
- 1つのコミットには1つの目的だけを入れます。
- シークレット（APIキー、パスワード、トークン）は絶対にコミットしません。

```
feat(api): add citation validation to chat responses

Reject citations that point to chunks outside the retrieved results.
Refs #12
```

## type（接頭語）の一覧

| type | 使う場面 | 例 |
| --- | --- | --- |
| `feat` | ユーザーから見える新機能を追加する | `feat(web): add bottom tab bar` |
| `fix` | バグを直す | `fix(api): return 403 for other users' data` |
| `security` | 脆弱性の修正や、セキュリティ対策の追加（テストを含む） | `security(api): add ownership checks for all routes` |
| `docs` | ドキュメントだけを変更する | `docs: add Google Cloud setup guide` |
| `spec` | Kiro の仕様書（requirements / design / tasks）を変更する | `spec: update requirements for pregnancy support` |
| `test` | テストを追加・修正する（実装の変更なし） | `test(shared): add property tests for age bands` |
| `refactor` | 動作を変えずに内部構造を整える | `refactor(collector): extract chunking module` |
| `perf` | 性能を改善する | `perf(api): cache embeddings of repeated queries` |
| `style` | 動作に影響しない整形（空白、フォーマット、セミコロン） | `style: format with prettier` |
| `build` | ビルド設定や依存関係を変更する | `build: pin vite to 6.0.0` |
| `ci` | CI/CD（GitHub Actions など）を変更する | `ci: add dependency audit workflow` |
| `chore` | 上記に当てはまらない雑務（設定ファイル、.gitignore など） | `chore: add .gitignore` |
| `revert` | 以前のコミットを取り消す | `revert: revert "feat(web): add tab bar"` |

迷ったときの目安: ユーザーに影響する変更は `feat` か `fix`、守りに関わる変更は `security`、仕様書だけなら `spec`、それ以外のドキュメントは `docs` です。

## scope（任意）

変更した範囲を、次のいずれかで示します。

| scope | 範囲 |
| --- | --- |
| `web` | `packages/web`（React PWA） |
| `api` | `packages/api`（Cloud Run の API） |
| `collector` | `packages/collector`（公的情報の収集ジョブ） |
| `shared` | `packages/shared`（共通の型・純粋関数） |
| `infra` | Firebase / Firestore のルール、インデックス、デプロイ設定 |
| `config` | `config/` 配下の設定 |
| `deps` | 依存パッケージ |

## 破壊的変更

互換性を壊す変更は、type の後ろに `!` を付け、本文に `BREAKING CHANGE:` を書きます。

```
feat(shared)!: rename ageBands to ageBandTags

BREAKING CHANGE: Firestore documents must be migrated.
```

## Issue との関連付け

本文の末尾に `Refs #番号`（関連）または `Closes #番号`（完了）を書きます。

## ブランチ運用

- `main` に直接コミットしません。必ずブランチを切り、Pull Request（PR）でマージします。
- ブランチ名は `<type>/<短い説明>` の形式にします（小文字、ハイフン区切り）。
  - 例: `feat/rag-chat`、`fix/citation-check`、`security/ownership-tests`、`docs/setup-guide`
- 機能または要件の区切りごとにブランチを切ります。
- マージ前に、CI のセキュリティチェックとテストがすべて成功している必要があります。
- PR のタイトルも、この規約と同じ形式で書きます。

## 書き方のチェックリスト

- [ ] type は一覧にあるものを使った
- [ ] 1行目が72文字以内で、命令形、小文字始まり、ピリオドなし
- [ ] 英語で書いた
- [ ] シークレットや個人情報を含めていない
- [ ] 1つのコミットに1つの目的だけを入れた