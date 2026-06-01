import { httpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { exchangeCodeForUserToken } from "./feishu/userAuth";
import { CUSTOMER_TABLE_ID } from "./feishu/customersMirror";
import { parseFeishuEventRequest, type RecordChange } from "./feishu/recordChangedEvent";

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

// Schedule the per-record mirror work so the webhook can answer Feishu with
// HTTP 200 inside its 3s window (record processing runs out-of-band).
async function scheduleRecordChanges(
  ctx: ActionCtx,
  changes: readonly RecordChange[],
): Promise<void> {
  for (const change of changes) {
    if (change.action === "record_deleted") {
      await ctx.scheduler.runAfter(0, internal.feishu.customersMirror.deleteByRecordId, {
        recordId: change.recordId,
      });
    } else {
      await ctx.scheduler.runAfter(0, internal.feishu.customersMirror.refreshRecordById, {
        recordId: change.recordId,
      });
    }
  }
}

// Feishu Event Subscription receiver for drive.file.bitable_record_changed_v1
// (ADR-0020). Verifies + decrypts (Encrypt Key), answers the url_verification
// handshake, and turns Customer-table record changes into instant mirror
// upserts/tombstones. Configure this URL (…/feishu/events) in the Feishu admin
// console with Encrypt Key + Verification Token set as Convex env vars.
http.route({
  path: "/feishu/events",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const rawBody = await req.text();
    const parsed = await parseFeishuEventRequest({
      rawBody,
      headers: {
        timestamp: req.headers.get("X-Lark-Request-Timestamp"),
        nonce: req.headers.get("X-Lark-Request-Nonce"),
        signature: req.headers.get("X-Lark-Signature"),
      },
      encryptKey: process.env.FEISHU_EVENT_ENCRYPT_KEY,
      verificationToken: process.env.FEISHU_EVENT_VERIFICATION_TOKEN,
    });
    if (parsed.kind === "challenge") {
      return jsonResponse({ challenge: parsed.challenge });
    }
    if (parsed.kind === "recordChanged" && parsed.tableId === CUSTOMER_TABLE_ID) {
      await scheduleRecordChanges(ctx, parsed.changes);
    } else if (parsed.kind === "ignored") {
      console.log(`[feishu events] ignored: ${parsed.reason}`);
    }
    return jsonResponse({ msg: "success" });
  }),
});

export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

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
