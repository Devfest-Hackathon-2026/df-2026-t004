import fc from "fast-check";

// プロパティベーステストの実行回数の既定値（設計書: numRuns は 100 以上）
fc.configureGlobal({ numRuns: 100 });
