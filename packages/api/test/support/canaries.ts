// ログのスキャン（タスク 2.7）で使うカナリア文字列。
// テストの入力に埋め込み、ログに1件も出ていないことを確認する。
// 他の場所に偶然現れない、一意な文字列にする。

export const CANARY_QUESTION = "カナリア質問7f3c9e2a児童手当はいつ振り込まれますか";
export const CANARY_NOTE = "カナリアメモb41d06e5子どもの通院記録";

export const CANARIES: readonly string[] = [CANARY_QUESTION, CANARY_NOTE];
