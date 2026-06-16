# Base Service row carries Initiator + Email Subject

> **Status: accepted.** Amends [ADR-0010](0010-pivot-to-bitable-intake.md) (which framed the Service row as "derivable-only — no email subject/body in Base"). Reverses *only* the Subject bullet; the **no-body-in-Base** rule from ADR-0010 still holds.

After the [ADR-0013](0013-customer-directory-preload-and-picker.md) deploy, the live Base Service row was filled with Request Type / Notes / Co Worker / Date of Offer / Client — but the salesperson's own identity (`Sales` column) and the email's `Email Subject` column remained empty even though both columns exist in the Service Table. The dev preview's "sync fails to write the sales-person field" complaint was about *this gap* (the create call itself returns 0; the columns are simply unset). ADR-0010 was written when those columns didn't matter; they do now.

## Decision

- **`Sales` (User, `multiple: false`)** is written with the signed-in Feishu user's `open_id` — the **Initiator**, distinct from the assignee **Coworker**. Format: `[{ "id": "<open_id>" }]` (official Feishu User-field shape, verified against `larksuite/oapi-sdk-go`).
- **`Email Subject` (Text)** is written with the intake's `subject` field as a plain string.
- **The Email Record gains `initiator: { openId, name } | undefined`** (strictly additive optional). Mirrors what was written to Base so the Convex audit row matches.
- **`Email Body` is NOT written.** The column does not exist in the live Service Table today, and per ADR-0010 we still store the body only as the ≤500-char `bodyPreview` on the Email Record. If a body column is added later, it gets its own ADR.
- **`Email Conversation ID` is written** with the current Outlook `item.conversationId` (the per-rep mailbox-local thread id) into this column as a Base-to-Outlook deep-link key. (Deferred at the time of writing, then introduced alongside [ADR-0017](0017-graph-self-forward-note-to-myself.md); when ADR-0017's Self-Forward was **reverted**, this column write **stayed** and is now owned by this ADR.) This supersedes the "wrong value" framing in the rejected-alternative below.

## Why

- **The product is sales-request intake.** A row missing the salesperson who logged it is a triage row no one can chase up. Writing it closes the loop.
- **`创建人` is not the salesperson.** Base's auto `创建人` column captures whichever identity *created* the row — that's the tenant-bot identity (`bitable:app`), not the human. A separate `Sales` User field is required to record the actual Initiator.
- **Subject is already in flight to Convex.** Mirroring it to Base costs one extra field write and makes the row scannable without opening Outlook.
- **Body stays out of Base.** The ADR-0010 reasoning still applies — bodies are unbounded text, vary wildly in formatting, would bloat row size, and the salesperson's structured Notes (Quotation Note / Sample Note / R&D Support Note) plus the ≤500-char preview on the Email Record together carry the triage signal.

## Consequences

- **The SPA must thread the signed-in user through the intake.** `useFeishuAuth()` already exposes `{ openId, userName }`; `RequestIntakeScreen` reads it and passes it as `initiator` on the `syncRequest` action call.
- **Service Table schema coupling tightens by two columns.** `Sales` and `Email Subject` must exist with those exact names on the live Base or the create call returns a 1254xxx field-not-found error. Verified present on 2026-05-28 against the deployed schema.
- **No new Feishu scope.** Both writes use the existing `bitable:app` tenant token ([ADR-0011](0011-feishu-permission-set.md)).
- **Email Record migration is additive.** Old records remain valid.
- **Open question (deferred):** if the user signs in via the **Fallback OAuth Callback** ([ADR-0008](0008-fallback-login-via-box.md)), the open_id comes from the box token rather than Convex's user-token DB. The session shape already exposes the open_id in both paths, so the Initiator write works in both — but worth verifying the first time the box-fallback path is exercised after this ships.

## Alternatives rejected

- **Use the `创建人` (CreatedUser) auto field.** Captures the bot identity, not the human. Wrong by construction.
- **Add a UI affordance to pick the Initiator.** Unnecessary — the Initiator is, by definition, whoever clicked Sync. A picker just lets people misattribute the row.
- **Write the email body to Base too.** No body column exists, the user explicitly dropped the request, and ADR-0010's reasoning still stands. Body stays preview-only on the Email Record.
- ~~**Write `Email Conversation ID` with Outlook's current conversationId.** That value will be replaced by a forwarded-thread conv id in the future auto-forward workflow; writing the wrong value now would mislead.~~ **Reversed:** the sales process turned out to be per-rep, not shared-inbox; Outlook's `item.conversationId` is exactly the right join key from the Base row back to the salesperson's mailbox view of the original client thread. (The per-rep Self-Forward "Note to myself" that [ADR-0017](0017-graph-self-forward-note-to-myself.md) introduced alongside this write has since been **reverted**; the `Email Conversation ID` write itself remains and is owned by this ADR.)

## References

- Create record: https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/create
- User-field format `[{ "id": "<open_id>" }]`: https://open.feishu.cn/document/docs/bitable-v1/app-table-record/bitable-record-data-structure-overview
- SDK reference: https://github.com/larksuite/oapi-sdk-go
