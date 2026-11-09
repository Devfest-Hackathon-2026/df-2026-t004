// 評価ハーネスのエントリ
import { SHARED_PACKAGE } from "@hachioji-gov/shared";

export const PACKAGE_NAME = "@hachioji-gov/eval" as const;
export const SHARED_REFERENCE = SHARED_PACKAGE;

export * from "./runner.js";
export * from "./sse.js";
