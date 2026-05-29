#!/usr/bin/env bun
// App-only end-to-end Graph test — no user interaction, no SSO, no manifest.
// Acquires a Microsoft Graph token via the OAuth2 client_credentials grant
//   https://learn.microsoft.com/entra/identity-platform/v2-oauth2-client-creds-grant-flow
// then sends a message via
//   POST https://graph.microsoft.com/v1.0/users/{fromUserPrincipalName}/sendMail
//   https://learn.microsoft.com/graph/api/user-sendmail
//
// Prerequisite on the AAD app (Entra → App registrations → emailtest):
//   - API permissions → Microsoft Graph → APPLICATION permissions (NOT delegated)
//     → add Mail.Send → Grant admin consent for tenant.
//   - If the test must run outside the tenant's "trusted IP" Conditional Access
//     boundary, exempt this app or add the calling IP to a trusted location.
//
// Usage (defaults match the live emailtest app config in this repo):
//   M365_CLIENT_ID=2ccb5d91-1bd7-4b62-9c3b-71d115c8af0a \
//   M365_CLIENT_SECRET=<secret value> \
//   M365_TENANT_ID=93b47f6a-5661-4677-a047-ab4fee1cad47 \
//   FROM_EMAIL=fanpc@fenchem.com \
//   TO_EMAIL=bourbakii@icloud.com \
//   bun scripts/m365-diag-app-only.mjs

const clientId = process.env.M365_CLIENT_ID;
const clientSecret = process.env.M365_CLIENT_SECRET;
const tenant = process.env.M365_TENANT_ID;
const fromEmail = process.env.FROM_EMAIL;
const toEmail = process.env.TO_EMAIL;
const subject = process.env.SUBJECT ?? "feishu-sync app-only diag";
const body =
  process.env.BODY ??
  "Local diagnostic from scripts/m365-diag-app-only.mjs via client_credentials + Graph /users/{id}/sendMail. If this arrived, the emailtest AAD app + Mail.Send application permission work end-to-end. The product Self-Forward uses the same app-only token and permission with Graph /messages/{id}/forward.";

function need(name, value) {
  if (!value) {
    console.error(`[FATAL] ${name} env var is required.`);
    process.exit(1);
  }
}
need("M365_CLIENT_ID", clientId);
need("M365_CLIENT_SECRET", clientSecret);
need("M365_TENANT_ID", tenant);
need("FROM_EMAIL", fromEmail);
need("TO_EMAIL", toEmail);

const ts = () => new Date().toISOString();
const log = (s) => console.log(`[${ts()}] ${s}`);
const err = (s) => console.error(`[${ts()}] ${s}`);

async function getAppToken() {
  log(`step=token start tenant=${tenant} clientId=${clientId.slice(0, 8)}…`);
  const t0 = Date.now();
  const res = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
      }).toString(),
    },
  );
  const json = await res.json();
  log(`step=token elapsed=${Date.now() - t0}ms status=${res.status}`);
  if (!res.ok) {
    err(`step=token FAILED error=${json.error} description=${json.error_description}`);
    err(`error_codes=${JSON.stringify(json.error_codes)} trace_id=${json.trace_id} correlation_id=${json.correlation_id}`);
    process.exit(2);
  }
  log(`step=token OK tokenType=${json.token_type} expiresIn=${json.expires_in}s`);
  return json.access_token;
}

async function sendMail(token) {
  log(`step=sendMail start from=${fromEmail} to=${toEmail} subjectLen=${subject.length}`);
  const payload = {
    message: {
      subject,
      body: { contentType: "Text", content: body },
      toRecipients: [{ emailAddress: { address: toEmail } }],
    },
    saveToSentItems: true,
  };
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromEmail)}/sendMail`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
  const reqId =
    res.headers.get("request-id") ??
    res.headers.get("x-ms-request-id") ??
    "(none)";
  if (res.status === 202) {
    log(`step=sendMail OK status=202 Accepted request-id=${reqId}`);
    console.log("");
    console.log(`✓ Graph sendMail accepted — check inbox: ${toEmail}`);
    console.log(`  Also check sent items on: ${fromEmail}`);
    return;
  }
  const text = await res.text();
  err(`step=sendMail FAILED status=${res.status} request-id=${reqId} body=${text}`);
  process.exit(3);
}

(async () => {
  try {
    const token = await getAppToken();
    await sendMail(token);
  } catch (e) {
    err(`fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(99);
  }
})();
