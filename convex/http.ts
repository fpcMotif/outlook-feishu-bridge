import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { exchangeCodeForUserToken } from "./feishu/userAuth";

const http = httpRouter();

export async function handleFeishuOAuthCallback(
  req: Request,
  exchange: (code: string, sessionId: string) => Promise<void>,
): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response(html("Authorization failed: missing code or state parameter."), {
      status: 400,
      headers: { "Content-Type": "text/html" },
    });
  }

  try {
    await exchange(code, state);
    return new Response(html("Login successful! You can close this window."), {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[feishu oauth callback] token exchange failed: ${message}`);
    return new Response(html(`Login failed: ${escapeHtml(message)}`), {
      status: 500,
      headers: { "Content-Type": "text/html" },
    });
  }
}

http.route({
  path: "/feishu/oauth/callback",
  method: "GET",
  handler: httpAction((ctx, req) =>
    handleFeishuOAuthCallback(req, (code, sessionId) =>
      exchangeCodeForUserToken(ctx, code, sessionId),
    ),
  ),
});

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
