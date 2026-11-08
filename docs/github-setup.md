# hachioji-gov GitHub セットアップ手順書

この手順書は、開発者本人が GitHub 側で手作業で行う設定をまとめたものです。リポジトリの設定はコードでは強制できないため、画面で設定します。設計の詳細は `.kiro/specs/childcare-medical-welfare-navi/design.md` の「セキュリティ・テスト戦略とCI/CD」を参照してください。Google Cloud 側の作業は [google-cloud-setup.md](./google-cloud-setup.md) にあります。

対象リポジトリ: https://github.com/yunamaki3/GDGoC2026.git

> 画面の名称や API は変更されることがあります。迷ったときは各節末尾の公式ドキュメントで最新の内容を確認してください。確認できていない点は「要確認」と書いています。シークレットの値は、この文書にもリポジトリにも書かないでください。

## 実装前の段階についての注意

この手順書は実装より先に書かれました。次のものは、タスク 3（#4）で実装済みです。

| 実装したもの | 設計書での場所 | 影響する手順 |
| --- | --- | --- |
| `.github/workflows/ci.yml`、`.github/workflows/pr-title.yml` | セキュリティ・テスト戦略とCI/CD (e) | 手順2（必須チェック名は確定） |
| `.github/dependabot.yml` | セキュリティ・テスト戦略とCI/CD (f) | 手順5 |
| Issue / PR テンプレート | — | 手順9 |

設計書の方針では、実装の順序は ①`ci`（ワークフローとブランチ保護）→ ②`security`（所有者検査の統合テスト）→ ③機能の実装です。最初の機能の Pull Request をマージする前に、手順1〜2のブランチ保護と必須チェックが有効になっている必要があります（Requirement 15.1, 15.7）。

## 0. 前提

- GitHub のアカウントに、対象リポジトリの管理者権限がある
- GitHub CLI（任意。`gh api` の例で使う）

```powershell
gh --version
gh auth login
gh auth status
```

- 以降のコマンドで使う変数（PowerShell）

```powershell
$REPO = "yunamaki3/GDGoC2026"
```

- リポジトリが公開か非公開か、プランが何かによって、使える機能が異なります（設計書 U-12）。**最初に確認してください。**

```powershell
gh repo view $REPO --json visibility,isPrivate,defaultBranchRef
```

| 機能 | 公開リポジトリ | 非公開リポジトリ |
| --- | --- | --- |
| ブランチ保護 / Rulesets | 利用できる | プランによっては利用できない（要確認） |
| CodeQL のコードスキャン | 利用できる | GitHub Code Security が必要な場合がある（要確認） |
| Secret scanning と push protection | 利用できる | GitHub Secret Protection が必要な場合がある（要確認） |
| Dependabot alerts / updates | 利用できる | 利用できる |

使えない機能がある場合の代替は、手順4に書いています（gitleaks の Actions など）。

## 1. ブランチ保護ルール（`main`）（Requirement 15.7, 15.8）

目的: `main` に直接コミットできないようにし、Pull Request（PR）と CI の成功を必須にします。ブランチ名とコミットの規則は [commit-convention.md](./commit-convention.md) に従います。

設定する内容:

| 設定 | 値 | 理由 |
| --- | --- | --- |
| Pull Request を必須にする | 有効 | `main` への直接のコミット・プッシュを禁止する（15.8） |
| 必須ステータスチェック | 手順2の一覧 | CI が成功しないとマージできない（15.7） |
| マージ前にブランチを最新にする | 有効 | 古い状態でマージして CI をすり抜けるのを防ぐ（Require branches to be up to date） |
| 管理者にも適用する | 下の選択を参照 | 自分自身の直接プッシュを防ぐ |
| 強制プッシュの禁止 | 有効 | 履歴の書き換えを防ぐ |
| ブランチの削除の禁止 | 有効 | `main` の誤削除を防ぐ |
| 会話の解決を必須にする | 任意 | レビューのコメントを残さない |

### 「管理者にも適用するか」の選択

設計書は、管理者にも適用する方針です。自分だけが開発している場合は、次の違いに注意して選んでください。

| 選択 | 良い点 | 注意点 |
| --- | --- | --- |
| 管理者にも適用する（推奨） | 自分も必須チェックを回避できず、設計書の方針と一致する | CI が壊れたときに、自分も直接の修正ができない。設定を一時的に外す必要がある |
| 管理者には適用しない | 緊急時に直接プッシュできる | 必須チェックを回避する操作が可能になり、セキュリティテストを先に作る方針が弱くなる |

おすすめは「管理者にも適用する」です。緊急時は、設定を一時的に変更し、作業後に戻して記録を残してください。

### レビュー承認の人数について

1人で開発している場合、「承認を1件必須」にすると、自分の PR を自分で承認できないため**マージできなくなります**。1人のときは、承認の必須人数を 0 にして（PR 自体は必須）、必須ステータスチェックで品質を守ります。共同開発者が増えたら 1 以上に変更します。

### 画面での設定手順（Branch protection rule）

1. リポジトリを開き、**Settings → Branches** を開く。
2. **Add branch ruleset** または **Add classic branch protection rule** を選ぶ。（画面の名称は変わることがある。要確認）
3. ブランチ名のパターンに `main` を入力する。
4. 次にチェックを入れる。
   - **Require a pull request before merging**（承認の必須人数は上の説明に従う）
   - **Require status checks to pass before merging**
     - **Require branches to be up to date before merging**
     - 必須チェックを検索して追加する（手順2）
   - **Require conversation resolution before merging**（任意）
   - **Do not allow bypassing the above settings**（管理者にも適用。classic の場合は **Do not allow bypassing the above settings** / **Include administrators**）
   - 強制プッシュと削除は許可しない（チェックを入れない）
5. **Create** / **Save changes** を押す。

> 必須ステータスチェックは、直近に一度でも実行されたチェックしか検索に出てきません。ワークフローを実装して最初の PR を出した後に、チェックを追加してください（手順2）。

### `gh api` を使った例

classic のブランチ保護を API で設定する例です。必須チェックの名前は手順2の**仮の名前**です。ワークフローの実装後に、実際の名前と一致していることを確認してから実行してください。

```powershell
$protection = @'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "static-analysis",
      "unit-and-property",
      "integration-security",
      "secret-scan",
      "dependency-audit",
      "codeql",
      "index-consistency",
      "pr-title"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
'@
$protection | gh api --method PUT "repos/$REPO/branches/main/protection" --input -
```

- `strict: true` が「マージ前にブランチを最新にする」です。
- `enforce_admins: true` が「管理者にも適用する」です。適用しない場合は `false` にします。
- `required_approving_review_count` は、共同開発者が増えたら 1 以上にします。
- 設定の確認:

```powershell
gh api "repos/$REPO/branches/main/protection" --jq "{strict: .required_status_checks.strict, checks: .required_status_checks.contexts, admins: .enforce_admins.enabled, force_push: .allow_force_pushes.enabled}"
```

- 非公開リポジトリで機能が使えない場合は、`HTTP 403` などのエラーになります。その場合は、リポジトリを公開にするか、プランを変更するか、**Rulesets** を試します（要確認）。

Rulesets（新しい仕組み）を使う場合の画面手順: **Settings → Rules → Rulesets → New ruleset → New branch ruleset**。対象を `main`（Default branch）にし、**Require a pull request before merging**、**Require status checks to pass**（**Require branches to be up to date** を含む）、**Block force pushes**、**Restrict deletions** を有効にします。バイパスのリストは空にします（管理者にも適用）。

公式: [保護されたブランチ](https://docs.github.com/ja/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)、[Rulesets](https://docs.github.com/ja/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)

## 2. CI の必須チェック名（Requirement 15.6, 15.7, 15.11）

`.github/workflows/ci.yml` は、PR（`opened`・`synchronize`・`reopened`）と `main` への push で次のジョブを並列に実行します。`pr-title` だけは、タイトルの編集（`edited`）でも再実行できるよう `.github/workflows/pr-title.yml` に分けています。

> **注意:** 必須ステータスチェックには、ワークフローの**ジョブ名**（`name:` を指定している場合はその値）が使われます。下の8つの名前は、ワークフローの `name:` と一致させています。ワークフロー側の名前を変えるときは、この表とブランチ保護の設定も同時に直してください。名前が一致しないと、PR が「チェック待ち」のまま永遠にマージできなくなります。

| 必須チェック名 | 内容 | 設計書の要件 |
| --- | --- | --- |
| `static-analysis` | `tsc --noEmit`、ESLint | 15.5 |
| `unit-and-property` | Vitest（ユニット + fast-check） | 15.1 |
| `integration-security` | Emulator での所有者以外の拒否の統合テスト、ログのスキャンテスト | 15.2, 15.3 |
| `secret-scan` | gitleaks | 15.3 |
| `dependency-audit` | `npm audit --audit-level=high --omit=dev` | 15.4 |
| `codeql` | CodeQL 解析 | 15.5 |
| `index-consistency` | `gen-indexes` の出力とコミット済み `firestore.indexes.json` の差分検査 | 13.14 |
| `pr-title` | PR タイトルが `docs/commit-convention.md` の形式であることの検査 | 15.10 |

手順:

1. `ci` のブランチ（例: `ci/add-workflows`）で、ワークフローを実装して PR を出す。
2. PR の **Checks** に表示されるチェックの名前を確認する（8つとも表示され、成功すること）。
3. 名前が一致しているか確認する。

```powershell
# 直近の PR のチェック名を確認する（<PR番号> は自分の PR の番号）
gh pr checks <PR番号> --repo $REPO
```

4. **Settings → Branches**（または Rulesets）の必須ステータスチェックに、8つを追加する（手順1の画面または `gh api`）。
5. 最初の PR を含めて、これ以降のすべての PR がチェックを通さないとマージできないことを確認する。

注意:
- 「パスで絞った実行（`paths:`）」をジョブに付けないでください。実行されないチェックは成功にならず、必須チェックが永遠に待ち続けることがあります。
- ワークフローの権限は、既定で `contents: read` にします。必要なジョブだけ昇格させます。サードパーティの Action は、コミット SHA で固定します（設計書 (e)）。

## 3. Actions の権限設定（Requirement 15.1）

目的: ワークフローが使う `GITHUB_TOKEN` を、読み取り専用の最小権限にします。

### 画面での設定手順

1. **Settings → Actions → General** を開く。
2. **Workflow permissions** で **Read repository contents and packages permissions**（読み取りのみ）を選ぶ。
3. **Allow GitHub Actions to create and approve pull requests** は、チェックを入れない（自動で PR を承認・作成させない）。Dependabot の PR には不要です。
4. **Actions permissions** で、使える Action の範囲を絞る。公式（GitHub）と検証済みの作者だけに限定するか、使う Action を許可リストに登録する。（要確認: 画面の選択肢の名称）
5. **Fork pull request workflows from outside collaborators** で、外部の貢献者の PR のワークフローは承認が必要にする（既定のまま確認するだけでもよい）。
6. **Save** を押す。

### `gh api` を使った例

```powershell
gh api --method PUT "repos/$REPO/actions/permissions/workflow" `
  -f default_workflow_permissions=read `
  -F can_approve_pull_request_reviews=false

# 確認
gh api "repos/$REPO/actions/permissions/workflow"
```

- 個々のワークフローで権限が必要な場合は、ジョブごとに `permissions:` を明示して昇格します（例: CodeQL は `security-events: write` が必要）。ワークフロー全体の既定を広げないでください。

公式: [GITHUB_TOKEN による認証](https://docs.github.com/ja/actions/security-for-github-actions/security-guides/automatic-token-authentication)

## 4. Secrets / Variables と Google Cloud への認証（Requirement 9.10）

### 現時点で必要なもの

設計書の CI は、PR 時の検査（型検査、テスト、gitleaks、監査、CodeQL など）だけを実行し、**Google Cloud へのデプロイは含みません**。そのため、現時点では Google Cloud の認証情報は**不要**です。実装が進んで必要になったときに、次の方針で登録してください。

### Secrets と Variables に入れるもの

名前と用途だけを示します。**値は、この文書にもリポジトリにも書かないでください。**

| 種別 | 名前（例） | 用途 | 現時点で必要か |
| --- | --- | --- | --- |
| Variable | `GCP_PROJECT_ID` | Google Cloud のプロジェクトID（機密ではないが公開リポジトリでは扱いに注意） | 不要（デプロイを CI に入れるとき） |
| Variable | `GCP_REGION` | リージョン（`asia-northeast1`） | 不要（同上） |
| Variable | `GCP_WORKLOAD_IDENTITY_PROVIDER` | Workload Identity Federation を使う場合のプロバイダ名 | 不要（同上） |
| Variable | `GCP_SERVICE_ACCOUNT` | 同上で借用するサービスアカウントのメール | 不要（同上） |
| Secret | （原則なし） | キーレス認証なら、サービスアカウントのキーを Secret に入れない | — |
| Secret | `GITLEAKS_LICENSE` | gitleaks-action を組織のリポジトリで使う場合のライセンス（個人のリポジトリでは不要なことが多い。要確認） | 要確認 |

- 機密値だけを Secrets に入れ、機密でない設定値は Variables に入れます。
- ログに値が出ないよう、ワークフロー内で `echo` しないでください。
- Secrets は、環境（Environments）を使って、本番デプロイのジョブにだけ渡すこともできます（任意）。
- テスト用のダミー値（`test-user@example.com` など）は、Secrets ではなくコードの固定値でよい設計です。

### Workload Identity Federation（キーレス認証）は任意

CI から Google Cloud を操作する必要が出た場合に、長期のサービスアカウントキーを GitHub に置かずに済む方法です。**必須ではありません。** 概要:

1. Google Cloud 側で、Workload Identity プールとプロバイダ（GitHub の OIDC を信頼する設定）を作る。
2. CI 用のサービスアカウントを作り、必要最小限のロールだけを付ける。`roles/owner` や `roles/editor` は付けない。
3. サービスアカウントを借用できる主体を、特定のリポジトリ（`yunamaki3/GDGoC2026`）と特定のブランチ・環境に限定する。
4. GitHub 側では、Variables にプロバイダ名とサービスアカウント名を入れ、ワークフローの `permissions` に `id-token: write` を付けて、公式の認証アクション（`google-github-actions/auth`）を使う。
5. サービスアカウントのキー（JSON）は作らない。

> 手順の細部（コマンド、条件式の書き方）は、利用時に公式ドキュメントで最新の内容を確認してください。要確認。

公式: [Google Cloud への OIDC 認証（GitHub）](https://docs.github.com/ja/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-google-cloud-platform)

### Secrets の登録手順（必要になったとき）

画面: **Settings → Secrets and variables → Actions → New repository secret**。Variables は同じ画面の **Variables** タブです。

```powershell
# 値は対話的に入力する（コマンド履歴に残さない）
gh secret set <NAME> --repo $REPO
gh variable set GCP_REGION --body "asia-northeast1" --repo $REPO
```

## 5. Dependabot（Requirement 15.4）

### 5-1. Dependabot alerts と security updates

脆弱性のある依存パッケージを検知し、修正の PR を自動で出します。

画面: **Settings → Code security**（または **Code security and analysis**）で、次を有効にする。（画面の名称は変わることがある。要確認）

- **Dependency graph**
- **Dependabot alerts**
- **Dependabot security updates**

`gh api` の例:

```powershell
# Dependabot alerts を有効にする
gh api --method PUT "repos/$REPO/vulnerability-alerts"
# Dependabot security updates を有効にする
gh api --method PUT "repos/$REPO/automated-security-fixes"

# 確認（204 が返れば alerts は有効）
gh api "repos/$REPO/vulnerability-alerts" -i
```

### 5-2. Dependabot version updates（`dependabot.yml`）

設計書では、`npm`（ルートと各パッケージ）と `github-actions` を週次で更新します。`.github/dependabot.yml` を置くと有効になります。

> **未実装の注記:** `.github/dependabot.yml` の作成は、実装の別タスクです。この手順書では置き場所と方針だけを示します。設定ファイルを置くと、それまでの設定は自動で有効になります。

確認すること（ファイルを置いたあと）:

1. **Insights → Dependency graph → Dependabot**（または **Settings → Code security → Dependabot**）で、ファイルが読み込まれ、エラーが出ていないことを確認する。
2. 更新の PR にも、同じ必須チェック（手順2）が実行されることを確認する。
3. 更新の PR のタイトルが `pr-title` チェックに通る形式であること（commit-convention の `build(deps)` など）を、`dependabot.yml` の `commit-message.prefix` で調整する。（要確認: 実装時に決める）
4. 更新の PR が多すぎる場合は、`open-pull-requests-limit` を設定して数を抑える。

公式: [Dependabot のクイックスタート](https://docs.github.com/ja/code-security/getting-started/dependabot-quickstart-guide)

## 6. コードスキャン（CodeQL）（Requirement 15.5）

設計書では、CodeQL を**ワークフローのジョブ `codeql`**として実行します（PR と週1回のスケジュール）。

**重要:** GitHub には、画面から有効にする「デフォルトのセットアップ（default setup）」もありますが、自分でワークフローを置く「詳細なセットアップ（advanced setup）」と併用できません。設計書の構成に合わせて、**デフォルトのセットアップは有効にせず、ワークフローで実行**してください。

手順:

1. `codeql` ジョブを含むワークフローを実装する（別タスク。実装前は未実装）。
2. ジョブの権限に `security-events: write` と `contents: read` を付ける。
3. **Settings → Code security → Code scanning** で、デフォルトのセットアップが無効（未設定）であることを確認する。
4. 最初の PR で `codeql` が成功することを確認し、必須チェックに加える（手順2）。
5. 結果の確認: **Security → Code scanning**。

使えない場合（非公開リポジトリで機能が提供されていないなど）は、代替として ESLint の `eslint-plugin-security` と、`static-analysis` のジョブで補います。その場合は設計書の必須チェック一覧を見直し、記録を残してください（設計書 U-12）。

公式: [コードスキャンの CodeQL](https://docs.github.com/ja/code-security/code-scanning/introduction-to-code-scanning/about-code-scanning-with-codeql)

## 7. Secret scanning と push protection（Requirement 15.3）

目的: シークレット（APIキーなど）を誤ってコミット・プッシュすることを防ぎます。

画面: **Settings → Code security → Secret scanning** で、次を有効にする。

- **Secret scanning**
- **Push protection**（シークレットを含むプッシュをブロックする）

`gh api` の例:

```powershell
$analysis = @'
{
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  }
}
'@
$analysis | gh api --method PATCH "repos/$REPO" --input -

# 確認
gh api "repos/$REPO" --jq ".security_and_analysis"
```

- 機能が使えない場合（非公開リポジトリのプランなど。設計書 U-12）は、`gitleaks`（CI の `secret-scan` ジョブ）が代替になります。ローカルでも、コミット前に `gitleaks` を実行する習慣を付けると安全です（任意）。
- push protection でブロックされたときは、シークレットを削除して**そのシークレットを失効（再発行）**します。ブロックを回避する「許可」は、テスト用のダミー値以外では使いません。
- 万一シークレットをコミットしてしまったら、履歴から消すだけでは足りません。必ずそのシークレットを失効させてください。

公式: [Secret scanning](https://docs.github.com/ja/code-security/secret-scanning/introduction/about-secret-scanning)、[Push protection](https://docs.github.com/ja/code-security/secret-scanning/introduction/about-push-protection)

## 8. ラベル

Issue と PR の分類に使うラベルを作ります。`type` ラベルは [commit-convention.md](./commit-convention.md) の type 一覧と同じ名前にします。

### type ラベル（commit-convention の type と一致）

| ラベル | 使う場面 |
| --- | --- |
| `feat` | ユーザーから見える新機能 |
| `fix` | バグ修正 |
| `security` | 脆弱性の修正、セキュリティ対策の追加（テストを含む） |
| `docs` | ドキュメントだけの変更 |
| `spec` | Kiro の仕様書の変更 |
| `test` | テストの追加・修正 |
| `refactor` | 動作を変えない内部整理 |
| `perf` | 性能改善 |
| `style` | 動作に影響しない整形 |
| `build` | ビルド設定、依存関係 |
| `ci` | CI/CD（GitHub Actions など） |
| `chore` | 上記以外の雑務 |
| `revert` | 取り消し |

### 補助ラベル

| ラベル | 使う場面 |
| --- | --- |
| `infra` | Firebase / Firestore のルール、インデックス、デプロイ設定（commit-convention の scope `infra` に対応） |
| `user-task` | 開発者本人が手作業で行う必要があるもの（Google Cloud や GitHub の設定など。AI や CI では代行できない） |
| `breaking-change` | 互換性を壊す変更（コミットの `BREAKING CHANGE:` に対応） |
| `dependencies` | Dependabot の更新（Dependabot が自動で付けることが多い） |
| `needs-decision` | 設計や方針の判断待ち（設計書の未確認事項 U-1〜U-14 に関するものなど） |

scope に対応するラベル（`web`、`api`、`collector`、`shared`、`config`、`deps`）が必要になったときは、同じ名前で追加します。

### 作り方

画面: **Issues → Labels → New label**。または `gh label create`:

```powershell
$labels = @(
  @{ name = "feat";            color = "1d76db"; description = "新機能" },
  @{ name = "fix";             color = "d73a4a"; description = "バグ修正" },
  @{ name = "security";        color = "b60205"; description = "セキュリティ対策・脆弱性の修正" },
  @{ name = "docs";            color = "0075ca"; description = "ドキュメントのみの変更" },
  @{ name = "spec";            color = "5319e7"; description = "Kiro の仕様書の変更" },
  @{ name = "test";            color = "bfd4f2"; description = "テストの追加・修正" },
  @{ name = "refactor";        color = "c5def5"; description = "動作を変えない内部整理" },
  @{ name = "perf";            color = "fbca04"; description = "性能改善" },
  @{ name = "style";           color = "ededed"; description = "整形のみ" },
  @{ name = "build";           color = "7057ff"; description = "ビルド設定・依存関係" },
  @{ name = "ci";              color = "0e8a16"; description = "CI/CD の変更" },
  @{ name = "chore";           color = "cfd3d7"; description = "その他の雑務" },
  @{ name = "revert";          color = "e99695"; description = "変更の取り消し" },
  @{ name = "infra";           color = "006b75"; description = "Firebase / Firestore の設定" },
  @{ name = "user-task";       color = "f9d0c4"; description = "開発者本人が手作業で行う作業" },
  @{ name = "breaking-change"; color = "b60205"; description = "互換性を壊す変更" },
  @{ name = "needs-decision";  color = "d876e3"; description = "判断待ち" }
)
foreach ($l in $labels) {
  gh label create $l.name --color $l.color --description $l.description --repo $REPO --force
}

# 確認
gh label list --repo $REPO
```

- `--force` を付けると、同名のラベルが既にある場合に更新されます（GitHub が最初から作る `documentation` などはそのまま残ります。不要なら画面から削除してよい）。
- 色は目安です。好みに合わせて変えて構いません。

公式: [ラベルの管理](https://docs.github.com/ja/issues/using-labels-and-milestones-to-track-work/managing-labels)

## 9. Issue / PR テンプレートの置き場所

テンプレートの**中身の実装は別タスク**です。この手順書では、置き場所だけを示します。ファイルを置いてデフォルトブランチ（`main`）にマージされると有効になります。

| 種類 | 置き場所 | 内容の方針 |
| --- | --- | --- |
| PR テンプレート | `.github/pull_request_template.md` | 変更の概要、type の選択、テストの結果、セキュリティの確認（シークレットや個人情報を含めていない）、関連 Issue（`Refs #番号` / `Closes #番号`） |
| Issue テンプレート | `.github/ISSUE_TEMPLATE/*.md` または `*.yml` | バグ報告、機能要望、`user-task`（手作業が必要な作業） |
| Issue テンプレートの設定 | `.github/ISSUE_TEMPLATE/config.yml` | 空の Issue を許可するか、問い合わせ先のリンクを設定する |

- PR のタイトルは、commit-convention と同じ形式で書きます（CI の `pr-title` が検査します）。
- 実装前に、置き場所のディレクトリがない場合は、`.github` 配下に作ります。
- 公式: [Issue と PR のテンプレート](https://docs.github.com/ja/communities/using-templates-to-encourage-useful-issues-and-pull-requests)

## 10. 確認チェックリスト

### ブランチ保護と CI

- [ ] リポジトリの公開／非公開と使える機能を確認した（手順0）
- [ ] `main` への直接プッシュができない（保護ルールまたは Ruleset が有効）
- [ ] PR が必須になっている
- [ ] 必須ステータスチェック（8つ）が、ワークフローの実際のチェック名と一致している（手順2）
- [ ] 「マージ前にブランチを最新にする」が有効
- [ ] 管理者にも適用するかを選び、結果を記録した
- [ ] 強制プッシュとブランチの削除が禁止されている
- [ ] 最初の機能の PR をマージする前に、上記がすべて有効になっている

### Actions と Secrets

- [ ] ワークフローの既定の権限が読み取り専用
- [ ] Action の自動 PR 承認が無効
- [ ] サードパーティの Action をコミット SHA で固定する方針を理解している
- [ ] Secrets / Variables にシークレットの値を入れていない（必要になるまで登録しない）
- [ ] サービスアカウントのキー（JSON）を GitHub に登録していない

### セキュリティ機能

- [ ] Dependabot alerts が有効
- [ ] Dependabot security updates が有効
- [ ] `.github/dependabot.yml` を置き、`npm` と `github-actions` が週次で更新される（実装後）
- [ ] CodeQL はワークフロー（`codeql` ジョブ）で実行され、デフォルトのセットアップと併用していない
- [ ] Secret scanning と push protection が有効（使えない場合は gitleaks で代替し、記録した）

### ラベルとテンプレート

- [ ] type ラベルが commit-convention の type 一覧と一致している
- [ ] `infra`、`user-task`、`breaking-change`、`needs-decision` のラベルがある
- [ ] PR / Issue テンプレートの置き場所を把握している（内容は別タスク）
