// 運営者 CLI パッケージのエントリ
import { SHARED_PACKAGE } from "@hachioji-gov/shared";

export const PACKAGE_NAME = "@hachioji-gov/admin" as const;
export const SHARED_REFERENCE = SHARED_PACKAGE;

export * from "./ports.js";
export * from "./commands.js";
export * from "./cli.js";
export * from "./config.js";
export * from "./memory.js";
export * from "./firestore.js";
