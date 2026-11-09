// 収集パッケージのエントリ
import { SHARED_PACKAGE } from "@hachioji-gov/shared";

export const PACKAGE_NAME = "@hachioji-gov/collector" as const;
export const SHARED_REFERENCE = SHARED_PACKAGE;

export * from "./ports.js";
export * from "./memory.js";
export * from "./text.js";
export * from "./fetcher.js";
export * from "./run.js";
export * from "./vertex.js";
export * from "./firestore.js";
