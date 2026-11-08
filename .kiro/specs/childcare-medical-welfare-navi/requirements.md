# Requirements Document

## Introduction

本ドキュメントは、八王子市の子育て世帯向け医療・福祉情報ナビ（アプリ名称「hachioji-gov」）の要件を定義する。本サービスは、国・東京都・八王子市が公開する医療・福祉・子育ての情報をベクトルDBに集約し、世帯ごとに合う制度をダッシュボードで提示し、出典つきでAIに相談できるスマートフォン向けPWAである。

MVPの対象は「八王子市に住む、子どもを持つ親」に絞る。MVPでは以下を含む：
- ユーザー登録・ログイン（F1、会員登録必須）
- 初回入力・オンボーディング（F2）
- 公的情報の収集・更新（F3、運営側）
- ダッシュボード（F4）
- AI相談・出典つきRAGチャット（F5）
- 医療費のまとめ（F6）

MVPでは以下を扱わない：
- F7（急な病気・けがへの対応）はMVPでは実装せず、いちど置いておく
- F8（締切の通知）と F9（世帯情報の管理と削除）は優先度「できれば」とする
- 八王子市以外の市区町村、子育て世帯以外（介護・障害福祉・高齢者）、マイナポータルAPI連携は含まない
- 妊娠・出産の制度は「子育て」に含め、MVPとして取り扱う

技術的制約として、インフラはGoogle Cloud、フロント・APIともTypeScript、個人開発予算内（20ドルクレジット範囲）で運用する。

## Glossary

- **Navi_App**: hachioji-govのPWAアプリケーション全体。スマートフォン向けに設計され、ホーム画面に追加してアプリのように使える
- **Onboarding_Module**: 初回入力を担うモジュール。郵便番号と子どもの人数・年齢を最小限で入力し、残りはあとから追加できる
- **Collection_System**: 公的情報を定期的に収集・更新するシステム。取得した内容を制度ごとのフォーマットに整理し、チャンク化・埋め込みを行ってベクトルDBに保存する
- **Dashboard**: 世帯に合う制度、進行中の申請、締切を表示する画面。制度カードのタップで詳細画面に遷移する
- **RAG_Chat**: 出典つきRAGで回答するAI相談機能。世帯情報で絞り込んだベクトル検索結果のみを根拠に回答し、引用番号と出典を表示する
- **Medical_Expense_Module**: 領収書の写真から必要情報（日付・医療機関名・金額・対象者）のみをテキストデータとして抽出し、医療費を集計し、申請に使える形にまとめる機能。元の画像は保存しない
- **Transient_Image**: ユーザーがアップロードまたは添付した画像（領収書の写真、チャットの添付画像）。個人情報が多く含まれるため、処理の完了（成功・失敗・キャンセルを問わず）後に直ちに削除し、永続的に保存しない
- **Notification_System**: 締切が近い申請や保存した制度の更新を通知する機能（優先度「できれば」）
- **RAG**: 検索で取り出した資料を根拠に、AIが回答を作る仕組み
- **Vector_DB**: 文章の意味を数値（ベクトル）にして保存し、意味の近いものを検索できるデータベース
- **Chunk**: 公的資料を検索しやすい大きさに分割した断片。出典URL・取得日などを付けて保存する
- **Program_Card**: ダッシュボードに表示する、制度1件ぶんの要約
- **PWA**: ホーム画面に追加して、アプリのように使えるWebアプリ
- **Sensitive_Personal_Info**: 障がいの有無など、個人情報保護法で特に慎重な扱いが求められる情報。取得前に本人の同意が必要
- **Municipality_Code**: 市区町村を表すコード。情報の絞り込みと、対応自治体の追加に使う
- **Program**: 国・都・市が提供する医療・福祉・子育ての制度
- **Household_Info**: 世帯情報。郵便番号、自治体コード、保護者の属性、子どもの情報、同意の記録を含む

## Requirements

### Requirement 1: ユーザー登録・ログイン

**User Story:** As a 八王子市の親, I want 登録してログインしたい, so that 複数の端末をまたいでデータを保持したままサービスを使える

#### Acceptance Criteria

1. WHEN 認証済みセッションを持たないユーザーが Navi_App を開いたとき、THE Navi_App SHALL 登録・ログイン画面を表示し、認証が成功するまでダッシュボード・AIチャット・世帯データを一切表示しない
2. WHEN ユーザーが Google アカウントでの登録を選択し Google 認証を完了したとき、THE Navi_App SHALL その Google アカウントに紐づくアカウントを作成し、認証完了から5秒以内に世帯オンボーディング画面へ遷移する
3. WHEN ユーザーがメールアドレスとパスワードを送信して登録したとき、THE Navi_App SHALL アカウントを作成し5秒以内に世帯オンボーディング画面へ遷移する。ただし、メールアドレスが254文字以内の有効な形式で、未登録であり、パスワードが8〜128文字である場合に限る
4. IF ユーザーが無効な形式のメールアドレス、登録済みのメールアドレス、または8〜128文字の範囲外のパスワードを送信したとき、THEN THE Navi_App SHALL 登録を拒否し、無効な入力欄の隣に具体的な理由を示すエラーメッセージを表示し、フォームに入力済みの他の値を保持する
5. IF ユーザーが Google 認証をキャンセルしたとき、認証に失敗したとき、または認証サービスに10秒を超えて接続できないとき、THEN THE Navi_App SHALL 登録・ログイン画面にとどまり、認証が完了しなかったことを示すエラーメッセージを表示し、再試行を可能にする
6. WHEN 登録済みユーザーが別の端末で有効な認証情報によりログインしたとき、THE Navi_App SHALL 4G以上のネットワークでログイン完了から5秒以内に、元の端末と同じ世帯情報・チャット履歴・申請状況・医療費記録を表示する
7. IF ユーザーが登録済みアカウントと一致しないメールアドレスとパスワードを送信したとき、THEN THE Navi_App SHALL ログインを拒否し、メールアドレスが登録済みかどうかを明かさずに認証情報が正しくないことを示すエラーメッセージを表示し、ログイン画面にとどまる
8. IF ユーザーが同一のメールアドレスで連続5回ログインに失敗したとき、THEN THE Navi_App SHALL そのメールアドレスへのログイン試行を15分間ブロックし、残りの待ち時間を示すエラーメッセージを表示する

### Requirement 2: 初回入力（オンボーディング）

**User Story:** As a 忙しい親, I want 最初は最小限の情報だけ入力し残りはあとで入力したい, so that すぐにダッシュボードを使い始められる

#### Acceptance Criteria

1. WHEN ユーザーが7桁の郵便番号を入力したとき、THE Onboarding_Module SHALL 都道府県・市区町村・町名を表示し、適用される情報源（国・東京都・八王子市）を示す
2. IF ユーザーが八王子市外の郵便番号を入力したとき、THEN THE Onboarding_Module SHALL 現在は八王子市のみ対応していることを示すメッセージを表示し、国の制度のみで続ける選択肢を提示する
3. IF ユーザーが存在しない郵便番号を入力したとき、THEN THE Onboarding_Module SHALL 入力欄の隣にエラーメッセージを表示し、ユーザーが先へ進めないようにする
4. THE Onboarding_Module SHALL 子どもの状況チップ（障がいの有無、スポーツの希望、留学の検討など）の複数選択と、最大200文字の自由記述入力を可能にする
5. WHERE ユーザーが「あとで入力する」を選択したとき、THE Onboarding_Module SHALL 必須項目（郵便番号、子どもの人数、子どもの年齢）のみでダッシュボードを作成する
6. WHEN ユーザーが Sensitive_Personal_Info に分類される健康関連情報を初めて入力したとき、THE Onboarding_Module SHALL 利用目的を提示し、保存前にユーザーの同意を取得する
7. IF ユーザーが Sensitive_Personal_Info への同意を拒否したとき、THEN THE Onboarding_Module SHALL 拒否された Sensitive_Personal_Info を保存せず、センシティブでない必須項目のみでオンボーディングを続けられるようにする
8. IF ユーザーが1〜20の範囲外の子どもの人数、または0〜18歳の範囲外の子どもの年齢を入力したとき、THEN THE Onboarding_Module SHALL 該当する入力欄の隣にエラーメッセージを表示し、ユーザーが先へ進めないようにする

### Requirement 3: 公的情報の収集・更新

**User Story:** As a システム運営者, I want 公的情報を定期的に収集・更新したい, so that 出典が確認できる最新の情報をベクトルDBに保持できる

#### Acceptance Criteria

1. WHEN 情報源に登録された取得間隔（既定: 24時間）が経過したとき、THE Collection_System SHALL その情報源（八王子市、東京都、厚生労働省のページおよびPDF）を取得する
2. WHEN 取得した内容が、その情報源について前回保存した内容とハッシュ値が同じであるとき、THE Collection_System SHALL チャンク化と埋め込みを省略し、既存のチャンクを変更せず、その情報源の最終取得日時を更新する
3. WHEN 取得した内容が前回の内容とハッシュ値が異なる、またはその情報源に前回の内容がないとき、THE Collection_System SHALL 内容を制度ごとの正式フォーマット（名称、対象、内容、申請方法、必要書類、締切、問い合わせ先、出典）に整理し、チャンクと埋め込みを作成して Vector_DB に保存し、その情報源について以前保存したすべてのチャンクを置き換える
4. WHEN チャンクを保存するとき、THE Collection_System SHALL そのチャンクに出典URL、取得日、Municipality_Code、レベル（国・東京都・市区町村）、対象年齢層、カテゴリを付与する
5. IF 取得処理が3回の試行後も失敗したとき（ネットワークエラー、30秒以内に応答なし、成功以外の応答、読み取れないページまたはPDF）、THEN THE Collection_System SHALL その情報源について以前保存したチャンクを変更せずに保持し、出典URL・時刻・失敗原因を含むエラー記録を残し、次回の定期取得で再試行する
6. IF 情報源が定期取得で2回連続して「見つからない」応答を返したとき、THEN THE Collection_System SHALL その情報源のチャンクを検索対象から除外し、除外を記録する
7. IF 正式フォーマットの Program の項目が取得内容から見つからないとき、THEN THE Collection_System SHALL 値を推測せずにその項目を空として保存し、残りの項目は保存する
8. IF ある情報源の取得または処理が失敗したとき、THEN THE Collection_System SHALL 同じ実行内で、登録されている残りの情報源の処理を続ける

### Requirement 4: ダッシュボード

**User Story:** As a 親, I want 自分の世帯に合う制度、進行中の申請、締切を見たい, so that 必要な制度を見つけて管理できる

#### Acceptance Criteria

1. WHEN ユーザーが Dashboard を開いたとき、THE Dashboard SHALL 4G接続で3秒以内に3つのセクションを表示する：(a) 対象年齢層と自治体コードが Household_Info に一致する Program、(b) 完了タスク数と全タスク数で進捗を示す進行中の申請、(c) 近い順に並べた締切
2. WHEN Dashboard が Program_Card を表示するとき、THE Dashboard SHALL そのカードに、行政レベル（国・東京都・市）、対象の家族、60文字以内の一行要約、出典名、YYYY/MM/DD 形式の更新日を表示する
3. WHEN ユーザーが Program_Card をタップしたとき、THE Dashboard SHALL 要点、手続きの流れ、必要なものチェックリスト、問い合わせ窓口、各出典の出典URLと取得日を含む出典一覧を含む詳細画面を表示する
4. WHEN ユーザーが詳細画面で「AIに聞く」をタップしたとき、THE RAG_Chat SHALL 検索対象をその Program に限定したチャットを開始し、要求に応じて、その Program の申請項目を1つずつ、ユーザーの Household_Info の値を入力候補として提示する
5. WHEN ユーザーが申請を「進行中」にしたとき、THE Dashboard SHALL その申請の締切と残りのタスクを、ダッシュボード上部のセクションに、締切が近い順で最大5件まで表示する
6. WHERE ユーザーがカテゴリで絞り込んだとき、THE Dashboard SHALL 選択したカテゴリに一致する Program のみを表示し、進行中の申請と締切のセクションは変更しない
7. IF Household_Info または選択したカテゴリに一致する Program がないとき、THEN THE Dashboard SHALL 該当する Program が見つからなかったことを示すメッセージを表示し、カテゴリの絞り込みを解除する操作を提示する
8. IF Program、申請、または締切の読み込みに失敗したとき、THEN THE Dashboard SHALL 影響を受けたセクションにエラーメッセージを表示し、再試行の操作を提示し、他のセクションは表示したままにする

### Requirement 5: AI相談（出典つきRAGチャット）

**User Story:** As a 親, I want 悩みを自由に相談し公的資料に基づく出典つきの回答を受け取りたい, so that 案内を信頼できる

#### Acceptance Criteria

1. WHEN ユーザーが質問を送信したとき、THE RAG_Chat SHALL Household_Info（自治体と子どもの年齢）で絞り込んだベクトル検索を行い、関連度の高い順に最大5件のチャンクを取得し、取得したチャンクのみを根拠として回答を生成する
2. WHEN RAG_Chat が回答を表示するとき、THE RAG_Chat SHALL 回答本文に連番の引用（例: [1]）を含め、各引用を取得したチャンクに対応させ、引用した各出典（資料名とURL）を回答の下に表示する
3. IF 引用番号が、取得した検索結果に存在しないチャンクを指しているとき、THEN THE RAG_Chat SHALL その引用を表示から除外する
4. IF ベクトル検索が一致するチャンクを1件も返さないとき、THEN THE RAG_Chat SHALL 取得したチャンク以外の情報に基づく回答の生成を控え、該当する資料が見つからなかったことをユーザーに伝え、ユーザーの市区町村の問い合わせ窓口を案内する
5. THE RAG_Chat SHALL ユーザーが、一般的な画像形式（JPEG、PNG など）で最大ファイルサイズ10 MBの画像（通知や書類の写真など）を1枚だけ質問に添付できるようにし、添付された画像を Transient_Image として扱う
6. WHEN RAG_Chat が回答の中で Program を提案するとき、THE RAG_Chat SHALL 「ダッシュボードに追加」ボタンを表示し、ユーザーが押したときにダッシュボードへ反映する
7. WHEN RAG_Chat が回答を表示するとき、THE RAG_Chat SHALL 最大3件の次の質問候補をチップとして表示する
8. IF ユーザーが病気の診断や治療の判断を求めたとき、THEN THE RAG_Chat SHALL 診断を控え、医師または市区町村の問い合わせ窓口への相談を勧める
9. IF 添付画像が非対応の形式である、最大ファイルサイズを超えている、または処理できないとき、THEN THE RAG_Chat SHALL その画像を直ちに削除し、画像を使えなかったことを示すエラーメッセージを表示し、入力された質問文を保持し、別の画像の添付または画像なしでの質問送信を可能にする
10. WHEN RAG_Chat が画像を添付した質問への回答生成を完了したとき（生成の成功・失敗・キャンセルを問わず）、THE RAG_Chat SHALL 添付画像を直ちに削除し、その画像をチャット履歴や永続的な保存先に保存しない（SHALL NOT）

### Requirement 6: 医療費のまとめ

**User Story:** As a 親, I want 領収書を撮影して医療費を記録したい, so that 集計して助成の申請に備えられる

#### Acceptance Criteria

1. WHEN ユーザーが10 MB以下のJPEGまたはPNG形式の領収書写真をアップロードしたとき、THE Medical_Expense_Module SHALL その写真を Transient_Image として扱い、日付・医療機関名・金額（円）・対象者のみをテキストデータとして抽出し、アップロードの95%以上で15秒以内に確認画面へ結果を表示する。対象者は Household_Info に登録された子どもまたは親と照合する
2. WHEN ユーザーが抽出結果を確認して保存したとき、THE Medical_Expense_Module SHALL その記録を世帯の医療費記録に追加し、暦月ごと・暦年ごと・家族ごとの合計を更新する。金額は1〜9,999,999円の整数とする
3. IF 領収書の写真から項目を抽出できない、または抽出した値が無効なとき、THEN THE Medical_Expense_Module SHALL その項目を空欄のままにして確認画面で強調表示し、手入力を促し、日付・医療機関名・金額・対象者がすべて入力されるまで保存できないようにする
4. IF アップロードされたファイルがJPEGまたはPNGでない、10 MBを超えている、または抽出処理が失敗もしくは30秒以内に終わらないとき、THEN THE Medical_Expense_Module SHALL アップロードされた画像を直ちに削除し、原因を示すエラーメッセージを表示し、領収書写真の再アップロードと手入力での記録のどちらかを選べるようにする
5. WHEN 記録が保存されたとき、THE Medical_Expense_Module SHALL 世帯の集計合計と Household_Info を Vector_DB 内の Program の条件と照合し、一致する Program を出典と取得日とともに最大5件提示する。提示する各 Program について、THE Medical_Expense_Module SHALL 該当期間の集計金額、含まれる領収書記録、まだ不足している必要書類を示す。Medical_Expense_Module は、ユーザーに代わって申請を提出しない（SHALL NOT）
6. WHEN 領収書写真の抽出が完了したとき（成功・失敗・ユーザーによるキャンセルを問わず）、THE Medical_Expense_Module SHALL 元の画像を直ちに完全に削除し、元の画像を永続的な保存先に保存しない（SHALL NOT）
7. IF 領収書画像の削除に失敗したとき、THEN THE Medical_Expense_Module SHALL 削除が成功するまで再試行し、その間は画像をユーザーおよび他のすべての機能からアクセスできないようにし、時刻と失敗原因を含むエラー記録を残す

### Requirement 7: 締切の通知（優先度：できれば）

**User Story:** As a 親, I want 申請の締切が近いことや制度の更新を通知してほしい, so that 重要な申請を逃さずに済む

#### Acceptance Criteria

1. WHERE ユーザーが通知の許可を与えているとき、WHEN 進行中の申請の締切が7日後または1日後になったとき、THE Notification_System SHALL その2つの時点のそれぞれで1件ずつプッシュ通知を送信し、各通知に Program 名と締切日を含める
2. WHEN 公的情報が更新され、ユーザーが保存した Program が変更されたとき、THE Notification_System SHALL ユーザーが次にアプリを開いてから5秒以内に、Program 名と更新された項目を示すアプリ内のお知らせを表示する
3. IF ユーザーが通知の許可を与えていない、または許可を取り消したとき、THEN THE Notification_System SHALL プッシュ通知を送信せず、締切のリマインダーはアプリ内のお知らせとして引き続き表示する
4. IF ユーザーの端末がiPhoneで、PWAがホーム画面に追加されていないとき、THEN THE Notification_System SHALL プッシュ通知を送信せず、ホーム画面への追加を案内するメッセージを表示する
5. IF プッシュ通知の送信に失敗したとき、THEN THE Notification_System SHALL 5分間隔で最大3回まで再試行し、すべての再試行が失敗した場合は代わりに締切をアプリ内のお知らせとして表示する
6. WHEN ユーザーが申請を完了としてマークした、または保存した Program を削除したとき、THE Notification_System SHALL その申請または Program に対する保留中の通知をすべて取り消す

### Requirement 8: 世帯情報の管理とアカウント削除（優先度：できれば）

**User Story:** As a 親, I want 世帯情報を管理して削除したい, so that 情報を最新に保ったり、すべてのデータを消したりできる

#### Acceptance Criteria

1. WHEN ユーザーが Household_Info の変更を保存したとき、THE Dashboard SHALL 保存完了から5秒以内に、保存された Household_Info を反映しておすすめの Program を更新する
2. IF Household_Info の変更の保存に失敗したとき、THEN THE Navi_App SHALL 以前保存した Household_Info を保持し、おすすめの Program を変更せず、保存に失敗したことと再試行できることを示すエラーメッセージを表示する
3. WHEN ユーザーが確認ダイアログでアカウント削除を確定したとき、THE Navi_App SHALL ユーザーの世帯情報、チャット履歴、医療費記録（抽出したテキストデータ）、アカウントを30秒以内に完全に削除し、ユーザーをサインアウトして削除完了メッセージを表示する
4. WHEN ユーザーがアカウント削除を要求したとき、THE Navi_App SHALL 削除が元に戻せないことを示す確認ダイアログを表示し、ユーザーが確定するまでデータを一切削除しない（SHALL NOT）
5. IF いずれかのデータ区分でアカウント削除に失敗したとき、THEN THE Navi_App SHALL 削除が完了しなかったことを示すエラーメッセージを表示し、ユーザーのサインイン状態を維持し、削除の再試行を可能にする

### Requirement 9: プライバシー・セキュリティ

**User Story:** As a 親, I want 個人データが保護され適法に扱われてほしい, so that 安心してサービスを使える

#### Acceptance Criteria

1. WHEN Navi_App が Sensitive_Personal_Info を取得しようとするとき、THE Navi_App SHALL 利用目的と収集するデータ項目を示した同意の確認を表示し、ユーザーが（事前選択ではない）明示的な操作で同意した後にのみ収集を開始する
2. IF ユーザーが同意を拒否した、または応答せずに同意の確認を閉じたとき、THEN THE Navi_App SHALL Sensitive_Personal_Info を収集も保存もせず、情報を収集しなかったことを示すメッセージを表示し、Sensitive_Personal_Info を必要としない他のすべての機能を利用可能なままにする
3. WHEN ユーザーが同意を撤回したとき、THE Navi_App SHALL 保存されているユーザーの Sensitive_Personal_Info を直ちに削除し、撤回操作の完了と同時に削除を完了させ、削除が完了したことの確認を表示する
4. IF 同意撤回時の Sensitive_Personal_Info の削除に失敗したとき、THEN THE Navi_App SHALL 削除が完了しなかったことを示すエラーメッセージを表示し、Sensitive_Personal_Info を削除処理以外のすべての機能からアクセスできないようにし、再試行の操作を提示する。WHEN ユーザーが再試行したとき、THE Navi_App SHALL 削除を繰り返し、成功した時点で完了の確認を表示する
5. THE Navi_App SHALL 領収書の写真とチャットの添付画像を Transient_Image として扱い、処理の終了後に各 Transient_Image を直ちに削除し、Transient_Image を永続的な保存先、バックアップ、ログに保存しない（SHALL NOT）
6. THE Navi_App SHALL 認証されたデータの所有者のみが自分のデータを読み書きできるようにアクセスを制限する
7. IF リクエストが他のユーザーのデータの読み書きを試みた、または未認証のユーザーから送られたとき、THEN THE Navi_App SHALL そのリクエストを拒否し、アクセスが拒否されたことを示すエラーを返し、対象のデータを変更しない
8. THE Navi_App SHALL すべてのユーザーデータを Google Cloud の東京リージョンに保存する
9. WHEN Navi_App が LLM へリクエストを送信するとき、THE Navi_App SHALL ユーザー由来の属性として自治体と子どもの年齢層のみを含め、氏名、住所、連絡先、Sensitive_Personal_Info を含めない
10. THE Navi_App SHALL API キーと認証情報を Google Secret Manager で管理し、ソースコードおよびクライアントに配信されるコードに含めない
11. WHEN ユーザーが初めて登録する、または初めて Navi_App にアクセスしたとき、THE Navi_App SHALL 利用規約とプライバシーポリシーを提示し、ユーザーが両方に明示的に同意した後にのみ登録を進められるようにする

### Requirement 10: AIの安全性

**User Story:** As a 親, I want AIの回答が公的資料に基づき適切な安全策が取られていてほしい, so that 案内を信頼できる

#### Acceptance Criteria

1. WHEN RAG_Chat が回答を生成するとき、THE RAG_Chat SHALL 回答内のすべての事実に関する記述を、ナレッジベース内の公的資料から取得した内容のみに基づかせ、事実に関する記述を含む各回答に少なくとも1件の出典参照（タイトルと出典URL）を付ける
2. IF 検索がユーザーの質問に対して設定されたしきい値以上の関連度スコアを持つ公的資料を返さないとき、THEN THE RAG_Chat SHALL 公的資料から回答が見つからなかったことを示すメッセージで応答し、裏付けのない内容を確立した事実として提示せず、八王子市の問い合わせ窓口の情報を表示する
3. IF ユーザーの質問が医学的な診断、症状の判断、または治療の判断を求めているとき、THEN THE RAG_Chat SHALL その判断を行わず、医師への相談を勧めるメッセージを表示し、診断や治療に関する推奨を一切出力しない
4. WHILE チャット画面が表示されているとき、THE RAG_Chat SHALL 診断と治療の判断は医師が行うべきであることを示す常設の注意書きを、スクロールせずに見える位置に、ユーザーが閉じられない形で表示する
5. WHEN Navi_App が Program の情報を表示するとき、THE Navi_App SHALL その情報の出典URLと取得日（YYYY-MM-DD 形式）を情報と並べて表示し、最新情報を問い合わせ窓口で確認するよう促す注意書きを付ける
6. IF Program の出典URLまたは取得日が欠けているとき、THEN THE Navi_App SHALL 出典が未確認であることを示す表示を行い、最新情報を問い合わせ窓口で確認するよう促す注意書きを付け、その注意書きを省略しない

### Requirement 11: 使いやすさ・アクセシビリティ

**User Story:** As a スマートフォンを使う親, I want アクセシブルで使いやすい画面にしたい, so that サービスを簡単に操作できる

#### Acceptance Criteria

1. THE Navi_App SHALL 縦向きで360px〜430pxの表示幅のすべての画面を、横スクロールなしで描画する。設計の基準幅は390pxとする
2. WHEN ユーザーが PWA 対応ブラウザで Navi_App を開いたとき、THE Navi_App SHALL ホーム画面へのインストールを案内し、インストール後はブラウザのアドレスバーなしのスタンドアロン表示モードで起動する
3. THE Navi_App SHALL タップ可能なすべての操作要素に、44px × 44px 以上のタップ領域と、隣接するタップ領域との間の8px以上の間隔を確保する
4. THE Navi_App SHALL 本文テキスト（18pt未満、または太字で14pt未満）と背景とのコントラスト比を4.5:1以上に、大きな文字と操作部品の境界線のコントラスト比を3:1以上に保つ
5. THE Navi_App SHALL すべての主要画面に、ホーム、さがす、AI相談、マイホームの順で、ちょうど4項目を含む常設の下部タブバーを表示する
6. WHEN ユーザーが下部タブバーの項目をタップしたとき、THE Navi_App SHALL 1秒以内に対応する画面を表示し、現在のタブを色だけに頼らない手がかり（ラベルの太さやアイコンの変化など）で視覚的に示す
7. WHEN ユーザーが Onboarding_Module を開始したとき、THE Onboarding_Module SHALL 完了までに必要な入力項目を最大3つにし、必須ではないすべての項目に「あとで入力する」の選択肢を用意する
8. WHEN ユーザーが項目について「あとで入力する」を選択したとき、THE Onboarding_Module SHALL その項目の検証エラーなしで次のステップへ進み、その項目をその後もマイホームから編集可能にしておく
9. IF 端末がオフラインである、または PWA のインストールに失敗したとき、THEN THE Navi_App SHALL ブラウザ上で動作を続け、制限があることを示すメッセージを表示し、すでに入力されたデータを保持する

### Requirement 12: 性能・可用性

**User Story:** As a 親, I want AIの応答が速く、電波が弱くてもコンテンツを閲覧できてほしい, so that 通信環境が悪くてもサービスを使える

#### Acceptance Criteria

1. WHEN ユーザーが質問を送信したとき、THE RAG_Chat SHALL ストリーミングで回答を少しずつ表示し始め、通常のネットワーク接続（下り1 Mbps以上）で、送信から3秒以内に最初のテキスト断片を表示する
2. WHILE 回答をストリーミングしているとき、THE RAG_Chat SHALL 受信したテキストを受信した順に表示中の回答へ追加し、表示の更新間隔を1秒以内にする
3. WHEN ユーザーが Program の情報ページを開いたとき、THE Navi_App SHALL その Program の情報をユーザーの端末にキャッシュし、最大50件までとし、上限を超えた場合は最も長く開かれていない Program を削除する
4. IF ネットワークが利用できない、または応答時間が5秒を超えたとき、THEN THE Navi_App SHALL 以前に開いた Program についてキャッシュされた Program 情報を、内容が最新でない可能性があることと最後にキャッシュした時刻の表示とともに表示する
5. IF ネットワークが利用できない間に、キャッシュされていない Program が要求されたとき、THEN THE Navi_App SHALL オフラインではその内容を利用できないことを示すメッセージを表示し、キャッシュ済みのすべての Program を閲覧可能なままにする
6. IF ストリーミング接続が回答の完了前に中断または失敗したとき、THEN THE RAG_Chat SHALL すでに表示された途中の回答を保持し、応答が不完全であることを示すエラー表示を出し、同じ質問を再送信する再試行の操作を提示する

### Requirement 13: 運用コスト・拡張性

**User Story:** As a システム運営者, I want 費用対効果が高く拡張しやすいインフラにしたい, so that 予算内で運用し、後で他の自治体へ展開できる

#### Acceptance Criteria

1. THE Navi_App SHALL 使用量課金で、待機時にインスタンス数がゼロまでスケールダウンするサービス（Cloud Run、Cloud Functions、Firestore など）のみを使用し、常時稼働のサーバーを使用しない（SHALL NOT）。これにより Google Cloud の累計利用額を20米ドル（クレジット予算）以下に保つ
2. THE Navi_App SHALL 請求アカウントに、予算額20米ドル、通知しきい値を予算の50パーセント・80パーセント・100パーセントとする Google Cloud の予算アラートを設定し、少なくとも1つの運営者のメールアドレスへ通知を送る
3. IF 累計利用額が20米ドルの予算の100パーセントに達したとき、THEN THE Navi_App SHALL しきい値を超えてから24時間以内に運営者へアラート通知を送信する
4. WHEN 運営者が Municipality_Code に関連付けた新しい情報源を登録したとき、THE Collection_System SHALL 収集ロジックのコードの変更・再ビルド・再デプロイなしで、次回の定期実行からその情報源の収集を開始する
5. IF 情報源の登録に有効な Municipality_Code または出典URLが欠けているとき、THEN THE Collection_System SHALL その登録を拒否し、既存の登録をすべて変更せずに保持し、どの項目が欠けているか、または無効であるかを示すエラーを報告する
6. THE Navi_App SHALL AIモデル名と Google Cloud のリージョンを TypeScript のソースコードの外にある設定ファイルで定義し、どちらかの値を変更するときに設定ファイルの編集のみで済み、ソースコードの変更を不要にする
7. IF 必須のAIモデル名またはクラウドのリージョンの値が、起動時に設定内で欠けている、または空であるとき、THEN THE Navi_App SHALL 起動に失敗し、どの設定キーが欠けているかを示すエラーを出力する
