// Fallback Feishu OAuth login — a tiny Bun server on the ECS Host (behind nginx
// at https://<host>/feishu/oauth/{start,callback}). It exists so login still
// works when the Convex action runtime is unavailable: the normal callback is a
// Convex HTTP action (convex/http.ts), and during a Convex action outage every
// action 500s while queries/mutations stay up. This path never touches Convex.
//
// It is driven by the Office Dialog API (ADR-0008), because window.open/postMessage
// is unreliable inside the Outlook taskpane:
//   1. SPA calls Office.context.ui.displayDialogAsync("<host>/feishu/oauth/start?state=…")
//      — the dialog's first page MUST be the add-in's own domain.
//   2. GET /start 302-redirects to the Feishu authorize page (cross-domain is OK
//      once the dialog has loaded a same-domain page first).
//   3. After consent Feishu redirects to GET /callback (same domain), which loads
//      office.js and calls Office.context.ui.messageParent(token) — the only way a
//      same-domain dialog page can hand data back to the taskpane.
// The SPA receives it via DialogMessageReceived, keeps the token in localStorage
// (no DB), and passes it to Coworker search as an argument.
//
// Run with Bun (no dependencies): `bun run index.ts`. Uses the `routes` API
// (Bun >= 1.2.3). Env (Bun auto-loads .env; systemd supplies them in prod):
//   FEISHU_APP_ID, FEISHU_APP_SECRET   — confidential-client credentials
//   FEISHU_FALLBACK_REDIRECT_URI       — must equal the redirect_uri sent to
//                                        authorize, e.g. https://<host>/feishu/oauth/callback
//   FEISHU_FALLBACK_SCOPE              — space-separated user scopes; MUST match the
//                                        SPA's FEISHU_USER_SCOPES (see useFeishuAuth.ts)
//   PORT                               — local port nginx proxies to (default 8788)

const FEISHU_API = "https://open.feishu.cn/open-apis";
const FEISHU_AUTHORIZE = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const OFFICE_JS = "https://appsforoffice.microsoft.com/lib/1/hosted/office.js";
const DEFAULT_SCOPE = "contact:user:search offline_access";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
}

const PORT = Number(process.env.PORT ?? 8788);
const CLIENT_ID = requireEnv("FEISHU_APP_ID");
const CLIENT_SECRET = requireEnv("FEISHU_APP_SECRET");
const REDIRECT_URI = requireEnv("FEISHU_FALLBACK_REDIRECT_URI");
const SCOPE = process.env.FEISHU_FALLBACK_SCOPE ?? DEFAULT_SCOPE;

interface TokenResponse {
  code?: number;
  error?: string;
  error_description?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

interface UserInfo {
  open_id: string;
  name?: string;
  avatar_url?: string;
}

// Exchange the authorization code for a user access token via the v2 OAuth
// endpoint: credentials go in the body (no Bearer bootstrap), unlike v1-OIDC.
async function exchangeCode(code: string): Promise<TokenResponse> {
  const res = await fetch(`${FEISHU_API}/authen/v2/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  const data = (await res.json()) as TokenResponse;
  if (!data.access_token) {
    const detail = data.error_description ?? data.error ?? `code ${data.code}`;
    throw new Error(`token exchange failed (${detail})`);
  }
  return data;
}

// v2 token response carries no open_id, so fetch the profile separately.
async function fetchUserInfo(accessToken: string): Promise<UserInfo> {
  const res = await fetch(`${FEISHU_API}/authen/v1/user_info`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = (await res.json()) as { code: number; msg: string; data: UserInfo };
  if (json.code !== 0) throw new Error(`user_info failed (code ${json.code}): ${json.msg}`);
  return json.data;
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function scriptSafeJsonLiteral(value: unknown): string {
  const json = JSON.stringify(JSON.stringify(value));
  const u = String.fromCharCode(92) + "u";
  const unsafe = new Set([0x3c, 0x3e, 0x26, 0x2028, 0x2029]);
  let out = "";
  for (const ch of json) {
    const code = ch.codePointAt(0) ?? 0;
    out += unsafe.has(code) ? u + code.toString(16).padStart(4, "0") : ch;
  }
  return out;
}

function sanitizeState(raw: string | null): string {
  const s = raw ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
    ? s
    : "";
}

// Render the dialog result page. It loads office.js and hands `parentMessage`
// (a JSON string) back to the taskpane via messageParent — the only supported
// channel for a same-domain Office dialog. Always posts, so the SPA's
// DialogMessageReceived handler fires on both success and failure.
function dialogPage(humanMessage: string, parentMessage: object): Response {
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Feishu Login</title>
<script src="${OFFICE_JS}"></script>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5}.card{background:#fff;padding:2rem;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1);max-width:400px;text-align:center}</style>
</head><body><div class="card"><p>${escapeHtml(humanMessage)}</p></div>
<script>
  Office.onReady(function () {
    try { Office.context.ui.messageParent(${scriptSafeJsonLiteral(parentMessage)}); } catch (e) {}
  });
</script></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

// GET /start — the dialog's same-domain entry point; 302 to Feishu authorize.
function handleStart(req: Request): Response {
  const state = new URL(req.url).searchParams.get("state") ?? "";
  const u = new URL(FEISHU_AUTHORIZE);
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("state", state);
  u.searchParams.set("response_type", "code");
  return Response.redirect(u.toString(), 302);
}

// GET /callback — Feishu redirects here with ?code&state; exchange and hand back.
async function handleCallback(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const code = params.get("code");
  const state = sanitizeState(params.get("state"));
  if (!code) {
    return dialogPage("Authorization failed: missing code.", {
      source: "feishu-fallback",
      state,
      error: "missing code",
    });
  }
  try {
    const token = await exchangeCode(code);
    const user = await fetchUserInfo(token.access_token!);
    // Expire 5 min early to avoid using a stale token (mirrors the Convex path).
    const expiresAt = Date.now() + ((token.expires_in ?? 0) - 300) * 1000;
    return dialogPage("Login successful! You can close this window.", {
      source: "feishu-fallback",
      state,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      expiresAt,
      openId: user.open_id,
      userName: user.name ?? null,
      avatarUrl: user.avatar_url ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[feishu-fallback] ${message}`);
    return dialogPage(`Login failed: ${message}`, {
      source: "feishu-fallback",
      state,
      error: message,
    });
  }
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 30,
  routes: {
    "/healthz": new Response("ok"),
    "/feishu/oauth/start": { GET: handleStart },
    "/feishu/oauth/callback": { GET: handleCallback },
  },
  fetch() {
    return new Response("not found", { status: 404 });
  },
  error(err) {
    console.error(`[feishu-fallback] ${err instanceof Error ? err.message : String(err)}`);
    return new Response("internal error", { status: 500 });
  },
});

// Clean shutdown on systemd stop/restart: let in-flight requests finish.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void server.stop();
    process.exit(0);
  });
}

console.log(`[feishu-fallback] listening on :${server.port}`);
