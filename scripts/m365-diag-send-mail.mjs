#!/usr/bin/env bun
// Minimal end-to-end Graph sendMail diagnostic.
//
// This intentionally bypasses Office.js / SSO / OBO. It uses the OAuth2 device
// code flow to acquire a delegated user token directly from Entra ID, verifies
// the signed-in Graph user with /me, then calls:
//   POST https://graph.microsoft.com/v1.0/me/sendMail
//
// If this succeeds from fanpc@fenchem.com to bourbakii@icloud.com, the AAD app
// and delegated Mail.Send path work. This is a local diagnostic only; the app's
// product path uses Convex app-only native Graph forward.
//
// Usage:
//   M365_CLIENT_ID=2ccb5d91-1bd7-4b62-9c3b-71d115c8af0a \
//   M365_TENANT_ID=93b47f6a-5661-4677-a047-ab4fee1cad47 \
//   bun scripts/m365-diag-send-mail.mjs
//
// Prerequisite on the AAD app:
//   Azure portal -> App registrations -> <app> -> Authentication ->
//   Advanced settings -> Allow public client flows = Yes
//
// Optional env:
//   TO_EMAIL         - recipient (default: bourbakii@icloud.com)
//   EXPECTED_SENDER - required signed-in Graph user before sending
//                     (default: fanpc@fenchem.com)
//   SUBJECT          - email subject
//   BODY             - plain text body
//   SCOPES           - Graph scopes (default: Mail.Send offline_access openid profile)
//   TENANT           - alias for M365_TENANT_ID

const clientId = process.env.M365_CLIENT_ID;
const FENCHEM_TENANT_ID = "93b47f6a-5661-4677-a047-ab4fee1cad47";
const tenant = process.env.M365_TENANT_ID ?? process.env.TENANT ?? FENCHEM_TENANT_ID;
const toEmail = process.env.TO_EMAIL ?? "bourbakii@icloud.com";
const expectedSender =
  process.env.EXPECTED_SENDER ?? process.env.FROM_EMAIL ?? "fanpc@fenchem.com";
const tenantSource = process.env.M365_TENANT_ID
  ? "M365_TENANT_ID"
  : process.env.TENANT
    ? "TENANT"
    : "default(Fenchem tenant)";
const subject =
  process.env.SUBJECT ??
  `feishu-sync M365 diag ${new Date().toISOString().replaceAll(":", "-")}`;
const body =
  process.env.BODY ??
  [
    "Local diagnostic test from scripts/m365-diag-send-mail.mjs.",
    "If you got this, delegated Microsoft Graph /me/sendMail worked end-to-end.",
    `Expected sender: ${expectedSender}`,
    `Recipient: ${toEmail}`,
  ].join("\n");
const scopes = process.env.SCOPES ?? "Mail.Send offline_access openid profile";

if (!clientId) {
  console.error("M365_CLIENT_ID is required. Example:");
  console.error(
    "  M365_CLIENT_ID=2ccb5d91-1bd7-4b62-9c3b-71d115c8af0a bun scripts/m365-diag-send-mail.mjs",
  );
  process.exit(1);
}

const auth = `https://login.microsoftonline.com/${tenant}`;

function ts() {
  return new Date().toISOString();
}

function log(line) {
  console.log(`[${ts()}] ${line}`);
}

function err(line) {
  console.error(`[${ts()}] ${line}`);
}

function decodeJwtPayload(jwt) {
  const [, payload] = jwt.split(".");
  if (!payload) return null;
  const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  try {
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function compactClaims(token) {
  const claims = decodeJwtPayload(token);
  if (!claims) return { decoded: false };
  return {
    decoded: true,
    aud: claims.aud,
    iss: claims.iss,
    tid: claims.tid,
    oid: claims.oid,
    preferred_username: claims.preferred_username,
    upn: claims.upn,
    scp: claims.scp,
    roles: claims.roles,
    exp: claims.exp,
  };
}

function sameEmail(left, right) {
  return (
    String(left ?? "").trim().toLowerCase() ===
    String(right ?? "").trim().toLowerCase()
  );
}

function aadHintLines(json, tenantValue) {
  const hints = [];
  const error = json?.error;
  const errorDescription = String(json?.error_description ?? "");
  const errorCodes = Array.isArray(json?.error_codes) ? json.error_codes : [];

  if (
    error === "invalid_client" ||
    errorCodes.includes(7000218) ||
    /public client flows/i.test(errorDescription)
  ) {
    hints.push(
      "public-client/device-code looks disabled on the app registration (AADSTS7000218 / invalid_client).",
    );
  }
  if (
    errorCodes.includes(50059) ||
    /No tenant-identifying information/i.test(errorDescription) ||
    tenantValue === "common"
  ) {
    hints.push(
      "tenant authority is not specific enough for this app. Re-run with M365_TENANT_ID set to the tenant GUID that owns the app; this is an AAD setup/authority problem, not Graph consent or sendMail yet.",
    );
  }
  if (
    error === "invalid_grant" ||
    error === "interaction_required" ||
    errorCodes.includes(65001) ||
    errorCodes.includes(65004) ||
    /consent|permission/i.test(errorDescription)
  ) {
    hints.push(
      "the app/user still looks short on delegated consent. Confirm Mail.Send consent for this tenant before chasing sendMail.",
    );
  }
  if (errorCodes.includes(53003) || /Conditional Access/i.test(errorDescription)) {
    hints.push(
      "Conditional Access blocked the token request. That is upstream of Graph/sendMail.",
    );
  }
  return hints;
}

async function readJsonOrText(res) {
  const text = await res.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

async function step1InitiateDeviceCode() {
  log(
    `step=devicecode start tenant=${tenant} tenantSource=${tenantSource} clientId=${clientId} scopes="${scopes}" expectedSender=${expectedSender} to=${toEmail}`,
  );
  const res = await fetch(`${auth}/oauth2/v2.0/devicecode`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: scopes }).toString(),
  });
  const { text, json } = await readJsonOrText(res);
  if (!res.ok) {
    err(`step=devicecode FAILED status=${res.status} body=${text}`);
    for (const hint of aadHintLines(json, tenant)) {
      err(`hint=${hint}`);
    }
    if (json?.error === "invalid_client") {
      err(
        "Hint: public client/device-code may be disabled on this app registration.",
      );
    }
    process.exit(2);
  }
  log(
    `step=devicecode OK user_code=${json.user_code} verification_uri=${json.verification_uri} expires_in=${json.expires_in}s interval=${json.interval}s`,
  );
  if (json.message) console.log(json.message);
  console.log("");
  console.log("====================================================================");
  console.log(`  OPEN IN BROWSER:  ${json.verification_uri}`);
  console.log(`  ENTER THIS CODE:  ${json.user_code}`);
  console.log(`  SIGN IN AS:       ${expectedSender}`);
  console.log("====================================================================");
  console.log("");
  return json;
}

async function step2PollForToken(deviceCodeResp) {
  log(
    `step=poll start deviceCode=${deviceCodeResp.device_code.slice(0, 16)}... interval=${deviceCodeResp.interval}s`,
  );
  const deadline = Date.now() + deviceCodeResp.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, deviceCodeResp.interval * 1000),
    );
    const res = await fetch(`${auth}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: deviceCodeResp.device_code,
      }).toString(),
    });
    const { text, json } = await readJsonOrText(res);
    if (res.ok && json?.access_token) {
      log(
        `step=poll OK tokenType=${json.token_type} expiresIn=${json.expires_in}s scope="${json.scope}"`,
      );
      log(`step=poll tokenClaims=${JSON.stringify(compactClaims(json.access_token))}`);
      return json.access_token;
    }
    if (json?.error === "authorization_pending") {
      log("step=poll authorization_pending (waiting for browser sign-in)");
      continue;
    }
    if (json?.error === "slow_down") {
      log("step=poll slow_down (backing off 5s)");
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }
    err(`step=poll FAILED status=${res.status} body=${text}`);
    for (const hint of aadHintLines(json, tenant)) {
      err(`hint=${hint}`);
    }
    process.exit(3);
  }
  err("step=poll TIMEOUT - user did not sign in before code expired");
  process.exit(4);
}

async function step3VerifyMe(accessToken) {
  log("step=me start GET https://graph.microsoft.com/v1.0/me");
  const res = await fetch(
    "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName",
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  const reqId =
    res.headers.get("request-id") ??
    res.headers.get("x-ms-request-id") ??
    "(none)";
  const { text, json } = await readJsonOrText(res);
  if (!res.ok) {
    err(`step=me FAILED status=${res.status} request-id=${reqId} body=${text}`);
    process.exit(5);
  }
  const actual = json.mail || json.userPrincipalName;
  log(
    `step=me OK request-id=${reqId} id=${json.id} displayName="${json.displayName}" mail=${json.mail} upn=${json.userPrincipalName}`,
  );
  if (!sameEmail(actual, expectedSender)) {
    err(
      `step=me REFUSE_TO_SEND expected=${expectedSender} actual=${actual}. Sign in with the expected sender or set EXPECTED_SENDER explicitly.`,
    );
    process.exit(6);
  }
}

async function step4SendMail(accessToken) {
  log(
    `step=sendMail start from=${expectedSender} to=${toEmail} subjectLen=${subject.length} bodyLen=${body.length}`,
  );
  const payload = {
    message: {
      subject,
      body: { contentType: "Text", content: body },
      toRecipients: [{ emailAddress: { address: toEmail } }],
    },
    saveToSentItems: true,
  };
  const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const reqId =
    res.headers.get("request-id") ??
    res.headers.get("x-ms-request-id") ??
    "(none)";
  if (res.status === 202) {
    log(`step=sendMail OK status=202 Accepted request-id=${reqId}`);
    console.log("");
    console.log(`Graph sendMail succeeded: ${expectedSender} -> ${toEmail}`);
    return;
  }
  const text = await res.text();
  err(
    `step=sendMail FAILED status=${res.status} request-id=${reqId} body=${text}`,
  );
  process.exit(7);
}

async function main() {
  const deviceCode = await step1InitiateDeviceCode();
  const token = await step2PollForToken(deviceCode);
  await step3VerifyMe(token);
  await step4SendMail(token);
}

main().catch((e) => {
  err(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(99);
});
