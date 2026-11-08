// ログの許可リスト（Requirement 15.3, Property 49）
// 質問文・世帯情報・メール・LLM の入出力・例外メッセージは、どのキーに入っていても出力しない。
// 出力してよいのは、型と形式を検査した次の5項目だけ。

export const LOG_ALLOWED_KEYS = [
  "requestId",
  "status",
  "durationMs",
  "errorType",
  "count",
] as const;

export type LogFields = {
  requestId?: string;
  status?: number;
  durationMs?: number;
  errorType?: string;
  count?: number;
};

// リクエストIDは、16〜64桁の16進数（トレースID）か UUID だけを受け付ける。
// 電話番号などの数字列や任意の文字列が紛れ込まないよう、形式を絞る。
const REQUEST_ID_PATTERN =
  /^(?:[0-9a-f]{16,64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// エラー種別は識別子（例: "ValidationError", "deadline_exceeded"）だけを受け付ける。
const ERROR_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const UNKNOWN_ERROR = "UnknownError";

function pickRequestId(value: unknown): string | undefined {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value) ? value : undefined;
}

function pickStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function pickDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function pickCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function pickErrorType(errorType: unknown, error: unknown): string | undefined {
  if (typeof errorType === "string") {
    return ERROR_TYPE_PATTERN.test(errorType) ? errorType : UNKNOWN_ERROR;
  }
  if (error === undefined || error === null) {
    return undefined;
  }
  // 例外のメッセージには入力内容が入りうるため使わない。名前（型）だけを使う。
  const name = error instanceof Error ? error.name : undefined;
  return typeof name === "string" && ERROR_TYPE_PATTERN.test(name) ? name : UNKNOWN_ERROR;
}

/**
 * ログのコンテキストから、許可リストの項目だけを取り出す。
 * - 許可リスト以外のキーは捨てる
 * - 許可リストのキーでも、型や形式が合わない値は捨てる
 * - `error`（例外オブジェクト）が渡されたときは、その名前だけを `errorType` にする
 */
export function redactForLog(ctx: Readonly<Record<string, unknown>>): LogFields {
  const out: LogFields = {};
  const requestId = pickRequestId(ctx["requestId"]);
  if (requestId !== undefined) out.requestId = requestId;
  const status = pickStatus(ctx["status"]);
  if (status !== undefined) out.status = status;
  const durationMs = pickDuration(ctx["durationMs"]);
  if (durationMs !== undefined) out.durationMs = durationMs;
  const errorType = pickErrorType(ctx["errorType"], ctx["error"]);
  if (errorType !== undefined) out.errorType = errorType;
  const count = pickCount(ctx["count"]);
  if (count !== undefined) out.count = count;
  return out;
}

// ---------------------------------------------------------------------------
// 構造化ロガー（Cloud Logging が解釈する JSON 1行形式）

export type LogSeverity = "DEBUG" | "INFO" | "WARNING" | "ERROR";

export type LogSink = (line: string, severity: LogSeverity) => void;

export type Logger = {
  debug(event: string, ctx?: Readonly<Record<string, unknown>>): void;
  info(event: string, ctx?: Readonly<Record<string, unknown>>): void;
  warn(event: string, ctx?: Readonly<Record<string, unknown>>): void;
  error(event: string, ctx?: Readonly<Record<string, unknown>>): void;
};

// イベント名はコード内の定数（例: "chat.completed"）だけを想定する。
const EVENT_PATTERN = /^[a-z][A-Za-z0-9_.:-]{0,63}$/;
const INVALID_EVENT = "invalid_event";

const defaultSink: LogSink = (line, severity) => {
  // ブラウザでは process が無いので何もしない
  const proc = (globalThis as { process?: NodeJS.Process }).process;
  if (proc === undefined) return;
  const stream = severity === "ERROR" || severity === "WARNING" ? proc.stderr : proc.stdout;
  stream.write(`${line}\n`);
};

export type LoggerOptions = {
  sink?: LogSink;
  now?: () => Date;
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());

  const write = (
    severity: LogSeverity,
    event: string,
    ctx: Readonly<Record<string, unknown>> = {},
  ): void => {
    const entry = {
      severity,
      message: EVENT_PATTERN.test(event) ? event : INVALID_EVENT,
      time: now().toISOString(),
      ...redactForLog(ctx),
    };
    sink(JSON.stringify(entry), severity);
  };

  return {
    debug: (event, ctx) => write("DEBUG", event, ctx),
    info: (event, ctx) => write("INFO", event, ctx),
    warn: (event, ctx) => write("WARNING", event, ctx),
    error: (event, ctx) => write("ERROR", event, ctx),
  };
}
