// Firebase Hosting は /api/** をパスを変えずに Cloud Run へ転送する（rewrites）。
// API のルートは /api を含まないため、受け取ったときに先頭の /api を取り除く。
// /healthz など、/api の付かないパスはそのまま通す。

export const API_PREFIX = "/api";

type Handler = (req: Request) => Response | Promise<Response>;

/** パスが /api または /api/... なら、/api を取り除いたパスを返す。そうでなければ null */
export function stripApiPrefix(pathname: string): string | null {
  if (pathname === API_PREFIX) return "/";
  if (pathname.startsWith(`${API_PREFIX}/`)) return pathname.slice(API_PREFIX.length);
  return null;
}

export function withApiPrefix(handler: Handler): Handler {
  return (req) => {
    const url = new URL(req.url);
    const path = stripApiPrefix(url.pathname);
    if (path === null) return handler(req);
    url.pathname = path;
    // 本文・ヘッダー・メソッド・中断のシグナルは元のリクエストのものを引き継ぐ
    return handler(new Request(url, req));
  };
}
