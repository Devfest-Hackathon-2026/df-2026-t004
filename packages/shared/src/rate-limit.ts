// レート制限（Requirement 1.9, 1.10）
// 固定窓のカウンタ。ユーザー別と IP 別で別々のリミッターを使い、互いに影響させない。

export type RateLimitEntry = {
  // 窓の開始時刻（ミリ秒）。窓は windowSec ごとに区切る
  windowStart: number;
  // その窓で受け付けた件数
  count: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  // この窓で、あと何件受け付けられるか
  remaining: number;
  // 拒否したとき、次の窓までの秒数（1以上 windowSec 以下）。受け付けたときは 0
  retryAfterSec: number;
  // 判定後のエントリ。呼び出し側で保存する
  entry: RateLimitEntry;
};

export type RateLimitOptions = { limit: number; windowSec: number };

/**
 * 1件のリクエストを受け付けるか決める。拒否したリクエストは数えない。
 */
export function evaluateRateLimit(
  entry: RateLimitEntry | undefined,
  nowMs: number,
  options: RateLimitOptions,
): RateLimitDecision {
  const windowMs = options.windowSec * 1000;
  const windowStart = nowMs - (((nowMs % windowMs) + windowMs) % windowMs);
  const count = entry !== undefined && entry.windowStart === windowStart ? entry.count : 0;
  if (count < options.limit) {
    return {
      allowed: true,
      remaining: options.limit - count - 1,
      retryAfterSec: 0,
      entry: { windowStart, count: count + 1 },
    };
  }
  return {
    allowed: false,
    remaining: 0,
    retryAfterSec: Math.max(1, Math.ceil((windowStart + windowMs - nowMs) / 1000)),
    entry: { windowStart, count },
  };
}

export type RateLimiter = {
  check(key: string, nowMs: number): RateLimitDecision;
  // テスト用。保持しているエントリ数
  size(): number;
};

/**
 * インスタンスのメモリ内で数えるリミッター。
 * 窓が過ぎたエントリは捨て、エントリ数が maxEntries を超えたら古いものから捨てる。
 */
export function createRateLimiter(options: RateLimitOptions & { maxEntries: number }): RateLimiter {
  const entries = new Map<string, RateLimitEntry>();
  const windowMs = options.windowSec * 1000;
  return {
    check(key, nowMs) {
      const decision = evaluateRateLimit(entries.get(key), nowMs, options);
      entries.delete(key);
      entries.set(key, decision.entry);
      for (const [k, e] of entries) {
        if (entries.size <= options.maxEntries && e.windowStart + windowMs > nowMs) break;
        if (k !== key) entries.delete(k);
      }
      return decision;
    },
    size: () => entries.size,
  };
}
