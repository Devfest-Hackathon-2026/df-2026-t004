<!--
PR のタイトルは docs/commit-convention.md の形式にしてください（CI の pr-title が検査します）。
例: feat(web): add bottom tab bar ／ security(api): add ownership checks for all routes
-->

## 概要

<!-- 何を、なぜ変えたか。tasks.md のタスク番号があれば書く -->

## type

<!-- 当てはまるものに x を付ける -->

- [ ] feat
- [ ] fix
- [ ] security
- [ ] docs / spec
- [ ] test
- [ ] refactor / perf / style
- [ ] build / ci / chore
- [ ] revert
- [ ] 破壊的変更あり（タイトルに `!`、本文に `BREAKING CHANGE:`）

## テストの結果

<!-- 実行したものに x を付け、実行できなかったものは理由を書く -->

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run test:security`（Emulator の統合テストとログのスキャン）
- [ ] 画面や API を実際に動かして確認した（該当する場合）

## セキュリティの確認

- [ ] シークレット（API キー、パスワード、トークン、サービスアカウントの鍵）を含めていない
- [ ] 実在の個人情報（氏名、電話番号、メール、住所）を含めていない。テストは固定のダミー値を使った
- [ ] ログに質問文・世帯情報・LLM の入出力を出していない（`redactForLog` を通している）
- [ ] `users/{uid}` を扱うルートを追加した場合、`OWNER_ROUTES` と所有者検査のテスト表に1行足した

## 関連 Issue

<!-- 完了するなら Closes #番号、関連なら Refs #番号 -->

Refs #
