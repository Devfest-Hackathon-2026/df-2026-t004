// API パッケージのエントリ（エンドポイントはタスク 12 以降で追加する）
import { SHARED_PACKAGE } from "@hachioji-gov/shared";

export const PACKAGE_NAME = "@hachioji-gov/api" as const;
export const SHARED_REFERENCE = SHARED_PACKAGE;

export * from "./app.js";
export * from "./auth.js";
export * from "./routes.js";
