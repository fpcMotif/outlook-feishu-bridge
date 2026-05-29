# M365 / Office.js: official sources only — and the current Mail Item surface

> **Status: accepted.** Parallels the standing rule that Feishu code cites `open.feishu.cn` + `github.com/larksuite/oapi-sdk-go` only (see ADR-0012's "Why official-only" footer). Establishes the same bar for everything we ingest from Outlook via Office.js. Touches [ADR-0010](0010-pivot-to-bitable-intake.md) (defines what we read from the **Mail Item**) and [ADR-0014](0014-write-initiator-and-subject-to-service-row.md) (which Mail-Item fields ride into the Base Service row).

The taskpane lives inside Outlook and reads the open mail item through Office.js. The risk profile is exactly the same as for Feishu: signatures drift, third-party wrappers lag and silently mis-shape payloads, and the runtime differs across Outlook variants (web / Win32 / Mac / mobile). To match the rigor we already apply on the Feishu side, every M365 API call we make must be traceable to an official Microsoft source.

## Decision

- **Allowed sources of truth for any M365 / Office.js / Microsoft Graph code:**
  - **MS Learn — Office.js API reference**: https://learn.microsoft.com/javascript/api/outlook/
  - **OfficeDev / office-js** (canonical type definitions): https://github.com/OfficeDev/office-js (the `office-js` npm package and its `office.d.ts`)
  - **OfficeDev / Office-Add-in-samples** (known-good pattern reference): https://github.com/OfficeDev/Office-Add-in-samples
  - **Microsoft Graph docs** (now used by ADR-0017's Self-Forward path; any future Graph expansion gets the same official-doc gate): https://learn.microsoft.com/graph + https://github.com/microsoftgraph/microsoft-graph-docs
- **Disallowed:** any third-party Office wrapper, community fork, or "easier" SDK. Same standing rule as Feishu.
- **Cite the doc URL in the ADR or inline comment** whenever a new Office.js property, method, or enum is introduced — the citation is what makes the choice auditable.
- **Read first, write second.** Office.js DOM types diverge from raw browser DOM in subtle ways (e.g. `Office.MailboxEnums` is undefined at module load — already a CONTEXT.md gotcha). Read the doc before adding the call.

## Current Office.js surface (the **Mail Item**)

This is what [`src/office/useMailItem.ts`](../../src/office/useMailItem.ts) + [`src/office/mailBody.ts`](../../src/office/mailBody.ts) read today. Each row cites the official Office.js reference; the SPA's typing on `Office.context.mailbox.item` is `Office.MessageRead & Office.ItemRead`.

| What | How | Reference |
|---|---|---|
| Subject | `item.subject` (string in read mode) | https://learn.microsoft.com/javascript/api/outlook/office.messageread#outlook-office-messageread-subject-member |
| Sender | `item.from.emailAddress` (`EmailAddressDetails.emailAddress`) | https://learn.microsoft.com/javascript/api/outlook/office.emailaddressdetails |
| To / Cc | `item.to[].emailAddress` / `item.cc[].emailAddress` | https://learn.microsoft.com/javascript/api/outlook/office.messageread#outlook-office-messageread-to-member |
| Date | `item.dateTimeCreated` (`Date`) | https://learn.microsoft.com/javascript/api/outlook/office.messageread#outlook-office-messageread-datetimecreated-member |
| Internet Message ID | `item.internetMessageId` | https://learn.microsoft.com/javascript/api/outlook/office.messageread#outlook-office-messageread-internetmessageid-member |
| EWS → REST ID | `Office.context.mailbox.convertToRestId(id, Office.MailboxEnums.RestVersion.v2_0)` | https://learn.microsoft.com/javascript/api/outlook/office.mailbox#outlook-office-mailbox-converttorestid-member |
| Conversation ID | `item.conversationId` | https://learn.microsoft.com/javascript/api/outlook/office.messageread#outlook-office-messageread-conversationid-member |
| Signed-in user (Outlook) | `Office.context.mailbox.userProfile.emailAddress` | https://learn.microsoft.com/javascript/api/outlook/office.userprofile |
| Plain-text body | `item.body.getAsync(Office.CoercionType.Text, callback)` → `result.value` | https://learn.microsoft.com/javascript/api/outlook/office.body#outlook-office-body-getasync-member(1) |
| Attachment metadata (gated) | `item.attachments` if `requirements.isSetSupported("Mailbox", "1.8")` | https://learn.microsoft.com/javascript/api/requirement-sets/outlook/outlook-api-requirement-sets ; https://learn.microsoft.com/javascript/api/outlook/office.attachmentdetails |
| Compose detection | `item.subject` is a `Subject` object (has `.getAsync`) in compose mode | https://learn.microsoft.com/javascript/api/outlook/office.subject |

**What we deliberately do NOT use** (and the rule for adding any of them):
- Microsoft Graph (`https://graph.microsoft.com`) — allowed only through ADR-scoped paths. ADR-0017 currently permits the server-side **Self-Forward** chain and defines **Email Conversation ID** as the original Mail Item conversation key, not a future shared-inbox thread key.
- Office.js add-in *commands* / ribbon entries — none today; the add-in is taskpane-only.
- `item.notificationMessages` / `Office.MailboxEnums.ItemNotificationMessageType` — the planned Outlook-category tag isn't built yet ([ADR-0010](0010-pivot-to-bitable-intake.md)); it would land here.

## Why official-only

- **Office.js DOM diverges from browser DOM.** `Office.MailboxEnums` is `undefined` at module load; `convertToRestId` requires the v2.0 enum value; `body.getAsync` is callback-shaped. A third-party "ergonomic" wrapper would smooth these over and silently fail the moment Microsoft revises a return shape — same failure mode that bit us with Feishu wrappers.
- **Outlook is four runtimes.** Web, Win32 (REVO), Mac, and mobile each implement Office.js slightly differently. The **requirement set** (`isSetSupported("Mailbox", "1.8")`) is the only contract that crosses them; only MS Learn documents which requirement set each member belongs to.
- **Auditability.** Every M365 read should be traceable to a doc URL the next reader can re-verify against the live `office-js` typings.

## Consequences

- **Office.js code carries the same citation discipline as Feishu code.** When you read the file, every non-obvious Office.js call is either cited in the table above or has its own inline link. Adding new ones means updating this table.
- **Mail Item is now a glossary term.** CONTEXT.md defines it; prefer it over "the mail" / "the message" / "the email" (the **Email Record** is the persisted derivative, the **Mail Item** is the live Office.js handle).
- **Graph stays off-limits except where an ADR opens the door.** [ADR-0017](0017-graph-self-forward-note-to-myself.md) opened the current door: Self-Forward uses Convex Backend app-only `POST /users/{selfEmail}/messages/{originalMessageId}/forward` with Microsoft Graph application `Mail.Send`. The old "ADR-0016" / common-inbox auto-forward wording is retired; ADR-0016 is the unrelated customer-search-modes ADR.
- **Plain-text body extraction is fixed.** `body.getAsync(Office.CoercionType.Text)` already returns the text-only body — attachments and inline images are stripped at the Office.js layer, not by us. This is the answer to "extract main email body, only text part no attachment nor picture" (the user's wording for this iteration). It is what we already do.

## References

- Office.js API reference (root): https://learn.microsoft.com/javascript/api/outlook/
- `office-js` package + types (canonical): https://github.com/OfficeDev/office-js
- Outlook add-in samples (patterns): https://github.com/OfficeDev/Office-Add-in-samples
- Outlook add-in requirement sets (what works in which host): https://learn.microsoft.com/javascript/api/requirement-sets/outlook/outlook-api-requirement-sets
- Read vs Compose mode semantics: https://learn.microsoft.com/javascript/api/outlook/office.mailbox#outlook-office-mailbox-item-member
