// admin CLI が使う設定だけを読む。生成モデル名など、運営操作に関係しない項目が未設定でも
// 運営スイッチの停止などを実行できるようにする（全体の検証は api と collector が行う）。

export type AdminConfig = {
  embedding: { model: string; dimensions: number; version: string; fieldPrefix: string };
  aiLocation: string;
  defaultIntervalHours: number;
};

export type AdminConfigResult = { ok: true; config: AdminConfig } | { ok: false; keys: string[] };

function pick(raw: unknown, path: readonly string[]): unknown {
  let value: unknown = raw;
  for (const key of path) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = Object.prototype.hasOwnProperty.call(value, key) ? Reflect.get(value, key) : undefined;
  }
  return value;
}

// 未設定の目印（"<設定する>" など）は値として扱わない
function isText(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "" && !/^<.*>$/.test(v.trim());
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

export function readAdminConfig(raw: unknown): AdminConfigResult {
  const keys: string[] = [];
  const text = (path: string): string => {
    const v = pick(raw, path.split("."));
    if (!isText(v)) keys.push(path);
    return isText(v) ? v : "";
  };
  const int = (path: string): number => {
    const v = pick(raw, path.split("."));
    if (!isPositiveInt(v)) keys.push(path);
    return isPositiveInt(v) ? v : 0;
  };
  const config: AdminConfig = {
    embedding: {
      model: text("embedding.model"),
      dimensions: int("embedding.dimensions"),
      version: text("embedding.version"),
      fieldPrefix: text("embedding.fieldPrefix"),
    },
    aiLocation: text("ai.location"),
    defaultIntervalHours: int("collector.defaultIntervalHours"),
  };
  return keys.length === 0 ? { ok: true, config } : { ok: false, keys };
}
