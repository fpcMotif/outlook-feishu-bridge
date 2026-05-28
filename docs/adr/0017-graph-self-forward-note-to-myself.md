# Self-Forward via app-only Graph native `forward`

> **Status: accepted.** Opens the Microsoft Graph door that [ADR-0015](0015-m365-office-js-official-sources.md) kept closed until a cited ADR existed. Amends [ADR-0014](0014-write-initiator-and-subject-to-service-row.md): the Bitable `Email Conversation ID` column stores the original Outlook Mail Item `conversationId`, not a forwarded-copy thread id.

Each **Bitable Sync** also forwards the original Outlook **Mail Item** into the **Initiator**'s own mailbox. The Self-Forward is not the retired Feishu Forward pipeline. It is a single Microsoft Graph native forward action, owned by the Convex Backend, and it soft-fails without rolling back the Bitable row.

## Decision

- **Write `Email Conversation ID` on create** with `Office.context.mailbox.item.conversationId`. That value is the salesperson's mailbox-local join key back to the original client thread.
- **Deliver the Self-Forward through Convex app-only Graph.** The SPA sends the current Mail Item's REST/Graph message id, `Office.context.mailbox.userProfile.emailAddress`, plus the just-synced **Customer name**, **client email**, and **request selections** to `m365.selfForward.sendSelfForwardNote`. Convex builds a short plain-text preamble (`Synced to Feishu Bitable / Client: <name> / Client email: <…> / Request types: <…> / <type> note: <…> / ------------------`) and passes it as the `comment` to Graph. Graph appends the original Outlook-rendered body below.
- **Message id conversion happens in Office.js:** `Office.context.mailbox.item.itemId` is EWS-shaped, so the SPA converts it with `Office.context.mailbox.convertToRestId(itemId, Office.MailboxEnums.RestVersion.v2_0)` before it reaches Convex.
- **Graph call shape:** Convex acquires an app-only token with `client_credentials` and then calls `POST /users/{selfEmail}/messages/{originalMessageId}/forward` with `toRecipients=[selfEmail]` and a short plain-text Bitable-sync `comment`. Outlook/Exchange owns the forwarded subject, header, original body rendering, and attachment handling.
- **Tenant authority is explicit:** the Entra app is single-tenant. `M365_TENANT_ID` must be `93b47f6a-5661-4677-a047-ab4fee1cad47` (or the same tenant set in Convex env). Do not default this path to `/common`; the local diagnostic proved `/common` fails with `AADSTS50059`.
- **Required Microsoft Graph permission:** application `Mail.Send`, granted admin consent on the Entra app. The backend uses `scope=https://graph.microsoft.com/.default`.
- **Secrets live in Convex env:** `M365_CLIENT_ID`, `M365_CLIENT_SECRET`, and `M365_TENANT_ID`.
- **No Office.js SSO dependency.** The Outlook manifest does not need `WebApplicationInfo`; the SPA does not call `OfficeRuntime.auth.getAccessToken`; and the add-in does not need `Mail.ReadWrite` delegated Graph scope for this path.
- **Failure model:** Bitable is authoritative. Self-Forward runs in parallel with the Bitable write. If mail sending fails, the user still lands on success with a retry chip. Retry re-runs only the Graph forward, never the Bitable create/update.

## Why Native Forward Replaced Synthetic `sendMail`

The first working local proof used app-only `sendMail` because it confirmed the tenant, app id, client secret, and `Mail.Send` application permission could send mail end-to-end. The first product implementation copied Office.js's plain-text body into a synthetic message with subject `Note to myself - <original subject>`.

The live Outlook result was not acceptable: plain-text coercion collapsed important formatting and made the original email body hard to read. Microsoft Graph's `message: forward` action has the same app-only `Mail.Send` least-privileged permission, but delegates the forward body to Outlook/Exchange. That is the right product behavior: use the platform's native forward format instead of rebuilding it. The only custom content is a small plain-text preamble above the forward body with the Customer and Request notes that were just synced.

## Alternatives

- **App-only `POST /users/{selfEmail}/sendMail` with a synthetic body**: proved the Entra/Graph send path, but rendered the original email poorly.
- **Office.js SSO + OBO + `createForward -> PATCH -> send`**: allows editing draft details, but requires `WebApplicationInfo`, Application ID URI, pre-authorized Office clients, delegated `Mail.ReadWrite` + `Mail.Send`, and OBO. Rejected because the live app registration and working proof are app-only, and native one-shot `forward` already supplies the needed format.
- **Graph `createForward -> PATCH -> send` with application permissions**: closer to editable subject/comment control, but requires application `Mail.ReadWrite` for `createForward`. Rejected for now because native `forward` only needs application `Mail.Send`.
- **Delegated device-code `POST /me/sendMail`**: useful as a local diagnostic, but not a product path because it requires interactive sign-in outside the add-in.
- **Writing the Self-Forward copy's conversationId to Bitable**: rejected. The Bitable join key remains the original Mail Item conversation id.

## Consequences

- `src/office/useMailItem.ts` converts the Office item id to a REST/Graph id.
- `convex/m365/selfForward.ts` is the public Convex action. It accepts `originalMessageId`, `selfEmail`, and the optional Bitable-sync context (`customerName`, `clientEmail`, `requestSelections`) used to build the preamble.
- `convex/m365/selfForwardMessage.ts` owns the pure preamble builder (`buildSelfForwardComment`) and the Graph `forward` request shape (`buildSelfForwardForwardBody`). Both are unit-tested with the exact text Outlook will render.
- `convex/m365/selfForwardChain.ts` owns the token and native `/users/{selfEmail}/messages/{originalMessageId}/forward` call.
- `src/hooks/useSelfForward.ts` is a thin Convex action wrapper; it does not call `OfficeRuntime.auth`.
- The Outlook manifest remains a normal taskpane/command manifest. Sideloading no longer depends on M365 client-id substitution or Office SSO manifest rules.
- Local diagnostics:
  - `scripts/m365-diag-send-mail.mjs` proves delegated `sendMail` and classifies tenant/device-code/consent failures.
  - `scripts/m365-diag-app-only.mjs` proves the app-only `Mail.Send` tenant/client-secret path. It is not the product endpoint anymore.

## References

- Client credentials flow: https://learn.microsoft.com/entra/identity-platform/v2-oauth2-client-creds-grant-flow
- Graph `message: forward`: https://learn.microsoft.com/graph/api/message-forward
- Graph `recipient`: https://learn.microsoft.com/graph/api/resources/recipient
- Office.js `convertToRestId`: https://learn.microsoft.com/javascript/api/outlook/office.mailbox#outlook-office-mailbox-converttorestid-member
- Office.js `userProfile`: https://learn.microsoft.com/javascript/api/outlook/office.userprofile
- Office.js Mail Item `conversationId`: https://learn.microsoft.com/javascript/api/outlook/office.messageread#outlook-office-messageread-conversationid-member
- Graph permissions reference (`Mail.Send` application): https://learn.microsoft.com/graph/permissions-reference#mail-permissions
