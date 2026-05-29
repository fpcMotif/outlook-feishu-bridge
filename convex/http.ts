import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { exchangeCodeForUserToken } from "./feishu/userAuth";

const http = httpRouter();

/**
 * Pure core of the Feishu OAuth callback. The httpAction wrapper only binds
 * `exchange` to `(code, state) => exchangeCodeForUserToken(ctx, code, state)`
 * so the query-parse, success, missing-param 400, and error 500 branches are
 * unit-testable without a live Convex ctx (mirrors selfForwardChain's injected
 * fetcher pattern).
 */
export async function handleFeishuOAuthCallback(
  req: Request,
  exchange: (code: string, sessionId: string) => Promise<void>,
): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  // state param contains the sessionId
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response(
      html("Authorization failed: missing code or state parameter."),
      { status: 400, headers: { "Content-Type": "text/html" } },
    );
  }

  // state format: sessionId (simple for now; can add CSRF nonce later)
  const sessionId = state;

  try {
    await exchange(code, sessionId);
    return new Response(
      html("Login successful! You can close this window."),
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
  } catch (err) {
    // Log the real cause server-side: a returned 500 Response is invisible in
    // Convex logs (only uncaught throws are logged), so without this the
    // failure shows only as the opaque generic envelope. This is the exact
    // "silent failure" class the observability work targets.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[feishu oauth callback] token exchange failed: ${message}`);
    return new Response(html(`Login failed: ${escapeHtml(message)}`), {
      status: 500,
      headers: { "Content-Type": "text/html" },
    });
  }
}

// The httpAction wrapper just binds ctx; the pure handleFeishuOAuthCallback
// (parse/success/400/500 branches) is unit-tested with an injected exchange fn.
/* v8 ignore start */
http.route({
  path: "/feishu/oauth/callback",
  method: "GET",
  handler: httpAction((ctx, req) =>
    handleFeishuOAuthCallback(req, (code, sessionId) =>
      exchangeCodeForUserToken(ctx, code, sessionId),
    ),
  ),
});
/* v8 ignore stop */

export function escapeHtml(str: string): string {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function html(message: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Feishu Login</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center;
           justify-content: center; height: 100vh; margin: 0; background: #f5f5f5; }
    .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            text-align: center; max-width: 400px; }
    .msg { margin-bottom: 1rem; font-size: 1.1rem; }
  </style>
</head>
<body>
  <div class="card">
    <p class="msg">${message}</p>
    <script>
      // Auto-close after a short delay so the user sees the message
      setTimeout(function() { window.close(); }, 1500);
    </script>
  </div>
</body>
</html>`;
}

export default http;
