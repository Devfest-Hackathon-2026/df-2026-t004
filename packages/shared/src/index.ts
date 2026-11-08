// 共有パッケージの公開エントリ。
// 後続タスクで、各パッケージ共通の型・定数・純粋関数をここから再エクスポートする。
export const SHARED_PACKAGE = "@hachioji-gov/shared" as const;

export * from "./config.js";
export * from "./authorize.js";
export * from "./log.js";
