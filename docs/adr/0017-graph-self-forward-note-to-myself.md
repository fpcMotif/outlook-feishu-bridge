# Self-Forward via Graph `createForward → PATCH → send` ("Note to myself")

> **Status: accepted.** Opens the door [ADR-0015](0015-m365-office-js-official-sources.md) deliberately closed (*"Graph stays off-limits until an ADR opens the door"*). Amends [ADR-0014](0014-write-initiator-and-subject-to-service-row.md) — reverses *only* the rejected-alternative bullet "Write `Email Conversation ID` with Outlook's current conversationId"; the **deferred** decision is now **accepted** as stated below. References [ADR-0012](0012-bitable-record-api.md) (record API used to write the new column) and [ADR-0010](0010-pivot-to-bitable-intake.md) / [ADR-0006](0006-forward-latency-parallelization.md) (the retired multi-target Forward pipeline — Self-Forward is a *different thing*, see "Terminology" below).

Each **Bitable Sync** now also delivers a personal annotation copy of the **Mail Item** into the **Initiator**'s own mailbox, with the subject `Note to myself — <original subject>`. The Bitable Service row's `Email Conversation ID` text column carries the Outlook `item.conversationId` as a join key back to the salesperson's mailbox view of the original client thread. Both writes happen in one sync.

## Decision

- **Write `Email Conversation ID` (Text) on create** with the value of `Office.context.mailbox.item.conversationId`. We have the value up-front in the SPA — no `PUT`-correction round-trip is needed; it rides into the initial `POST /bitable/v1/apps/.../records` body.
- **Deliver the Self-Forward** by chaining three Graph calls:
  1. `POST /me/messages/{id}/createForward` → returns a `Message` draft with `id`, `subject` (defaulted to `"FW: <subject>"`), and `conversationId`. Doc: https://learn.microsoft.com/graph/api/message-createforward
  2. `PATCH /me/messages/{draftId}` with body `{ "subject": "Note to myself — <original subject>" }`. Doc: https://learn.microsoft.com/graph/api/message-update
  3. `POST /me/messages/{draftId}/send`. Doc: https://learn.microsoft.com/graph/api/message-send
- **Recipient is `Office.context.mailbox.userProfile.emailAddress`** — the signed-in Outlook user. The Self-Forward goes into *their own* inbox, not a shared inbox. Doc: https://learn.microsoft.com/javascript/api/outlook/office.userprofile
- **Message id passed to Graph is the REST v2 id**, converted from the Office.js EWS id via `Office.context.mailbox.convertToRestId(item.itemId, Office.MailboxEnums.RestVersion.v2_0)` (already cited in [ADR-0015](0015-m365-office-js-official-sources.md)).
- **Auth model: Office.js SSO + Convex On-Behalf-Of** (the Microsoft-recommended pattern for Outlook taskpane add-ins).
  - SPA: `OfficeRuntime.auth.getAccessToken({ allowSignInPrompt: true, allowConsentPrompt: true, forMSGraphAccess: true })` returns a bootstrap token representing the signed-in user against *our* Azure AD app. Doc: https://learn.microsoft.com/office/dev/add-ins/develop/sso-in-office-add-ins
  - Convex action: `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, `assertion=<bootstrap>`, `requested_token_use=on_behalf_of`, `scope=https://graph.microsoft.com/Mail.Send`. Doc: https://learn.microsoft.com/entra/identity-platform/v2-oauth2-on-behalf-of-flow
  - The OBO result is a delegated Graph access token used for the three calls above.
- **New scopes:** delegated `Mail.Send` only. `Mail.ReadWrite` is **not** required — `createForward` does not require Read; the message body Graph fetches server-side for the forward is authorized by Graph itself against the user's mailbox. Scope reference: https://learn.microsoft.com/graph/permissions-reference#mail-permissions
- **Secrets** live in **Convex env** (`bunx convex env set …`), mirroring the existing `FEISHU_APP_ID` / `FEISHU_APP_SECRET` pattern:
  - `M365_CLIENT_ID` — the Application (client) ID of the Azure AD app.
  - `M365_CLIENT_SECRET` — a client secret value created on the app.
  - `M365_TENANT_ID` — typically `common` for multi-tenant; can be a specific tenant GUID when locking to Fenchem only.
- **Both manifests gain a `WebApplicationInfo` block** carrying the same `Id` (= `M365_CLIENT_ID`) and `Resource` (= `api://<addin host>/<client-id>`). The block is what makes Office.js SSO issue a bootstrap token at all. Doc: https://learn.microsoft.com/office/dev/add-ins/develop/sso-in-office-add-ins#configure-the-add-ins-manifest
- **Failure model: soft-fail with retry chip.** Bitable is authoritative. Self-Forward runs in parallel with the Bitable write; if the forward fails, the `SyncScreen` reports `[✓] Synced` with a small `[⚠ Note-to-myself failed — retry]` chip the user can click. Retry re-runs only the Graph chain — never the Bitable write (the row already exists; retrying it would create a duplicate, violating [ADR-0012](0012-bitable-record-api.md)'s no-touch rule).

## Why the `createForward → PATCH → send` chain (detailed, with citations)

Graph offers **three** ways to put a copy of a received message into another mailbox, and only one of them honours the "Note to myself — <subject>" requirement. The trade-off is plain when you read each endpoint's official contract side-by-side. All quotes / behaviour notes below are from MS Learn (URLs in References) — no third-party wrappers, per [ADR-0015](0015-m365-office-js-official-sources.md).

### Option A — `POST /me/messages/{id}/createForward` → `PATCH` → `send` ✅ chosen

- **Endpoint 1**: `POST /me/messages/{id}/createForward` (https://learn.microsoft.com/graph/api/message-createforward). Returns **a Message resource in the user's Drafts folder** — full editable shape including `id`, `subject`, `body`, `toRecipients`, `conversationId`. The default subject is `"FW: <original subject>"`; the default body is Graph's server-rendered forward (original headers — From / Sent / To / Subject — followed by the original body).
- **Endpoint 2**: `PATCH /me/messages/{draftId}` (https://learn.microsoft.com/graph/api/message-update). Updateable properties on a draft include `subject`, `body`, `toRecipients`, `bccRecipients`, `ccRecipients`, `replyTo`. We send only `{ "subject": "Note to myself — <original>", "toRecipients": [{ "emailAddress": { "address": "<self>" } }] }`. We do *not* touch `body` — Graph's auto-generated forward body is exactly the format we want (with the original message's From / Sent / To / Subject headers preserved).
- **Endpoint 3**: `POST /me/messages/{draftId}/send` (https://learn.microsoft.com/graph/api/message-send). Submits the draft for delivery. Returns `202 Accepted`.
- **Cost**: three HTTP round-trips from Convex to Graph (~600–900 ms total over a healthy link).
- **What we get**: exact subject control + true forward semantics — the email that lands in your inbox renders in Outlook as a forwarded message (with the standard `From: <client> | Sent: <date> | To: <you> | Subject: <original>` block at the top of the body), not as a fresh mail we cobbled together. This is the only path that gives both.

### Option B — `POST /me/messages/{id}/forward` (single call) ❌ rejected

- **Endpoint**: https://learn.microsoft.com/graph/api/message-forward. One call. Body accepts only `comment` (a string prepended to the forwarded body) and `toRecipients`. **The subject is server-set to `"FW: <original subject>"` and cannot be overridden by the request body** — there is no `subject` field on the request schema.
- **Why rejected**: the spec requires the literal subject `"Note to myself — <original subject>"`. Option B cannot produce that subject. Cheap, but produces the wrong result.

### Option C — `POST /me/sendMail` with composed body (single call) ❌ rejected

- **Endpoint**: https://learn.microsoft.com/graph/api/user-sendmail. One call. The request body carries a `Message` resource the *caller* fully constructs (subject, body, toRecipients).
- **Why rejected**:
  1. **Loses forward semantics.** There is no `createForward` step, so the body we send is our string only — no Graph-rendered `From: … | Sent: … | To: … | Subject: …` header block. We'd be hand-stitching that header from `Office.context.mailbox.item.{from,to,cc,dateTimeCreated,subject}` and the plain-text body from `body.getAsync(Office.CoercionType.Text)`. The Office.js plain-text body **already has inline images and attachments stripped** ([ADR-0015](0015-m365-office-js-official-sources.md)) — fine — but reproducing the exact Outlook forward header format by hand is a maintenance liability, and it'll drift the moment Microsoft tweaks the layout.
  2. **No `inReplyTo` / no thread continuity at the source.** `sendMail` creates a wholly new message with no relationship to the original; `createForward` carries `inReplyTo` / `references` headers automatically, so Outlook clients can still group the note next to the original in conversation view if the user wants it to.
  3. **Same scope cost.** Both require delegated `Mail.Send`. No savings.

### Side-by-side

| Aspect | A. createForward + PATCH + send (chosen) | B. forward (rejected) | C. sendMail (rejected) |
|---|---|---|---|
| Round-trips | 3 | 1 | 1 |
| Subject control | ✅ exact | ❌ server-forced `"FW: …"` | ✅ exact |
| Auto-rendered forward header | ✅ Graph generates | ✅ Graph generates | ❌ caller must hand-stitch |
| Attachments carried | ✅ (Graph carries from source) | ✅ | ❌ caller must include |
| Thread headers (`inReplyTo` / `references`) | ✅ | ✅ | ❌ |
| Required scope | `Mail.Send` | `Mail.Send` | `Mail.Send` |
| Doc | createForward + update + send | forward | sendMail |

The extra 600 ms is bought back by **never having to re-derive Outlook's forward formatting in code we own**. Microsoft owns that formatting; we should let them own it.

## Auth model — why Office.js SSO + Convex OBO over MSAL.js popup

Three official paths exist; MS Learn's "Authorize add-ins" page (https://learn.microsoft.com/office/dev/add-ins/develop/authorize-microsoft-graph) explicitly recommends Office.js SSO for taskpane add-ins:

> *"The Office Add-ins single sign-on (SSO) feature gives access to a user's Microsoft Graph data from an Office Add-in without requiring users to sign in a second time."*

- **Office.js SSO + Convex OBO** (chosen) — no popup, no dialog, no second sign-in. The SPA calls `getAccessToken({ forMSGraphAccess: true })` and forwards the bootstrap to a Convex action that completes the OBO exchange. The Graph forward then runs *on the server* — observable in `bunx convex logs`, retryable, and the client_secret never leaves the Convex env.
- **MSAL.js popup** (rejected) — works for plain SPAs but in Outlook Web Add-ins the popup can be blocked by host policy, and putting Graph calls in the SPA means the three round-trips run from the browser instead of one Convex action. Also forces an extra "sign in to Microsoft" popup the user already passed when signing into Outlook — a regression in UX.
- **`displayDialogAsync` OAuth code flow** (rejected) — same pattern as the existing **Fallback OAuth Callback** ([ADR-0008](0008-fallback-login-via-box.md)). Most code to write; would need a new Bun route on the ECS Host *and* CSP / cookie configuration to mirror the Feishu fallback. The whole point of SSO is to avoid that complexity when Microsoft provides the bootstrap token natively.

## Failure model in detail

The three Graph calls fail in three different ways; the soft-fail UX collapses them into one observable surface:

1. **`getAccessToken` fails** — typically `13001` (user not signed in) / `13003` (unsupported runtime) / `13005` (`Mail.Send` not consented). Each surfaces as the same chip `Note-to-myself failed — retry`. Doc: https://learn.microsoft.com/office/dev/add-ins/develop/troubleshoot-sso-in-office-add-ins
2. **OBO exchange fails** — Convex returns the AAD error code as part of the action result. Most likely `invalid_grant` (bootstrap expired) or `interaction_required` (admin consent not granted). Same chip.
3. **Any Graph call returns non-2xx** — the chain logs the failing endpoint + the Graph `request-id` header (a future Sentry breadcrumb wires this up). Same chip.

The retry chip re-runs the **entire chain from the bootstrap call** — getting a fresh bootstrap is cheap, and OBO results are not cached for this iteration. The Bitable row is never touched on retry: the row already exists with `Email Conversation ID` set, and a Bitable re-write would either duplicate (create) or modify a *no-longer-just-created* row (PUT — forbidden by [ADR-0012](0012-bitable-record-api.md)'s bounded-correction rule once we've left the sync session).

## Terminology — "Self-Forward" vs the retired "Forward pipeline"

CONTEXT.md says *Avoid "forward" / "the forward pipeline"* — the multi-target chat / bot / Doc dispatch [ADR-0010](0010-pivot-to-bitable-intake.md) retired. To prevent semantic regression:

- **Self-Forward** (new term) — the *one* Graph-driven copy delivered to the **Initiator**'s own mailbox per **Bitable Sync**, subject prefixed `"Note to myself — "`. One per sync. Never sent to anyone else.
- **Forward (retired)** — the historical multi-target dispatch (Feishu bot + chat + Doc + PDF). Gone.

The two share an English word but nothing else: targets are different (own mailbox vs Feishu fan-out), failure model is different (soft-fail chip vs full pipeline failure), transport is different (Graph vs Feishu), and the *purpose* is different (personal annotation vs delivery).

## Consequences

- **New Azure AD app registration is required.** Multi-tenant (`accountTypes = "AzureADMultipleOrgs"` if Fenchem may onboard external sales reps later, otherwise single-tenant). Expose an API `api://<addin host>/<client-id>` with one scope `access_as_user` and pre-authorize Outlook web/desktop client IDs per https://learn.microsoft.com/office/dev/add-ins/develop/sso-in-office-add-ins#configure-the-add-ins-manifest. Add a delegated `Mail.Send` permission on Microsoft Graph; admin consent required.
- **Both manifests gain a `WebApplicationInfo` block.** Sideload + Cloudflare Pages deploy + ECS deploy all need to re-pin the manifest after the AAD app id is known.
- **`bitable.ts` + `serviceRow.ts` learn one new column.** `Email Conversation ID` is a Text field on the live Service Table (verified against the deployed schema 2026-05-28 — same audit list as ADR-0014's verification). Adding to the create payload is `if (input.emailConversationId) fields["Email Conversation ID"] = input.emailConversationId;` — a single line, unit-tested in `serviceRow.test.ts`.
- **`requestSync.syncRequest` intake gains `emailConversationId: v.optional(v.string())`.** The SPA already passes `mailItem.conversationId` to `sync`; we propagate it through `serviceRowArgs`. No change to the Email Record — `conversationId` is already stored there.
- **New module `convex/m365/selfForward.ts`.** Houses the OBO exchange + the three-Graph-call chain. Mirror's the Feishu module layout (`auth.ts` + `bitable.ts` next to `call.ts`). Citations inline at every endpoint.
- **`useRequestSync` exposes a second action.** `sendSelfForwardNote` runs alongside `syncRequest` and returns `{ ok: true } | { ok: false, code, message }`. `RequestIntakeScreen.runSync` calls both in parallel (`Promise.allSettled`) and renders the chip on the SyncScreen / ReceivedScreen.
- **No change to existing Feishu code paths.** Bitable Sync is unchanged; Self-Forward is additive.

## Alternatives rejected

- **`POST /me/messages/{id}/forward`** — single call, but subject is server-set to `"FW: …"`. Cannot meet the literal subject requirement.
- **`POST /me/sendMail` with hand-composed body** — single call with subject control, but loses Graph's server-rendered forward header block and forces us to maintain Outlook-format-equivalent code in our repo. Microsoft owns that format; we should let them.
- **MSAL.js popup, SPA-side Graph** — extra popup UX, popups blocked on some Outlook hosts, three round-trips from the browser, secret-free but observability-light.
- **`displayDialogAsync` OAuth code flow** — most code to write, no benefit over SSO once we have a Convex action runtime.
- **Storing `M365_CLIENT_SECRET` on the ECS Host** — wrong locality for the OBO exchange (login.microsoftonline.com is reached from Convex, not ECS, per [ADR-0009](0009-cloudflare-global-host-dual-deploy.md)'s outbound-from-US posture); doubles the secret-rotation surface.
- **Hard-fail (rollback Bitable row on forward failure)** — would require a Bitable DELETE, which [ADR-0012](0012-bitable-record-api.md) forbids (the add-in only creates + correction-updates rows *it just created*; it never deletes).
- **Writing the forwarded message's `conversationId` to Bitable** (ADR-0014's deferred intent). Operationally cleaner — the column would join the row to a thread *anyone* on the team can see in a shared inbox — but the current sales process is per-rep, and the salesperson's view of the *original* client thread (their own `item.conversationId`) is more useful as a Bitable-to-Outlook deep link. Revisit if/when a shared-inbox model is introduced.

## References (official, all on learn.microsoft.com or github.com/Office* / github.com/microsoftgraph)

- Office.js SSO overview: https://learn.microsoft.com/office/dev/add-ins/develop/sso-in-office-add-ins
- Office.js SSO sample: https://github.com/OfficeDev/Office-Add-in-samples/tree/main/Samples/auth/Outlook-Add-in-SSO
- Authorize add-ins with Microsoft Graph: https://learn.microsoft.com/office/dev/add-ins/develop/authorize-microsoft-graph
- On-behalf-of flow: https://learn.microsoft.com/entra/identity-platform/v2-oauth2-on-behalf-of-flow
- `createForward`: https://learn.microsoft.com/graph/api/message-createforward
- `message-update` (`PATCH`): https://learn.microsoft.com/graph/api/message-update
- `message-send`: https://learn.microsoft.com/graph/api/message-send
- `message-forward` (rejected path): https://learn.microsoft.com/graph/api/message-forward
- `user-sendmail` (rejected path): https://learn.microsoft.com/graph/api/user-sendmail
- Graph permissions reference (`Mail.Send`): https://learn.microsoft.com/graph/permissions-reference#mail-permissions
- Office.js `convertToRestId`: https://learn.microsoft.com/javascript/api/outlook/office.mailbox#outlook-office-mailbox-converttorestid-member
- Office.js `userProfile`: https://learn.microsoft.com/javascript/api/outlook/office.userprofile
- `OfficeRuntime.auth.getAccessToken`: https://learn.microsoft.com/javascript/api/office-runtime/officeruntime.auth#office-runtime-officeruntime-auth-getaccesstoken-member(1)
- SSO error codes: https://learn.microsoft.com/office/dev/add-ins/develop/troubleshoot-sso-in-office-add-ins
