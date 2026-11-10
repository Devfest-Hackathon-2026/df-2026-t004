// API パッケージのエントリ
import { SHARED_PACKAGE } from "@hachioji-gov/shared";

export const PACKAGE_NAME = "@hachioji-gov/api" as const;
export const SHARED_REFERENCE = SHARED_PACKAGE;

export * from "./app.js";
export * from "./auth.js";
export * from "./routes.js";
export * from "./middleware.js";
export * from "./operations.js";
export * from "./server.js";
export * from "./chat/types.js";
export * from "./chat/pipeline.js";
export * from "./chat/route.js";
export * from "./chat/firestore.js";
export * from "./chat/vertex.js";
export * from "./household.js";
export * from "./dashboard.js";
export * from "./postal-data.js";
