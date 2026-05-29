# Pivot from email forwarding to Feishu Base sales-request intake

> **Status: accepted.** Supersedes the multi-target forward model — retires [ADR-0004](0004-binaries-cross-via-convex-file-storage.md), [ADR-0005](0005-email-pdf-is-text-only-vector.md), and [ADR-0006](0006-forward-latency-parallelization.md); amends [ADR-0003](0003-feishu-user-scopes-and-search-v1.md).

The add-in began as a way to **forward a copy** of an Outlook email into Feishu via three independent targets — bot webhook, group chat, and Base — carrying a generated email **PDF**, the original **attachments**, and an optional **Feishu Doc**. The product is now narrower: a **sales-request intake** tool. A salesperson opens a client's inbound email, records one or more **Requests** (Quotation / Sample / R&D Support, each a free-text note), assigns exactly one Feishu **Coworker**, and the add-in writes **one structured row** to a Feishu **Base** — with a recoverable **Email Record** kept in Convex. Forwarding to chat/bot, and the PDF / attachment / Doc machinery, are **retired**.

## Decision

- **Single output: the Base row.** Each synced email produces one row (Request Types, Request Notes, one Coworker, Date, and a Client link when the sender's domain matches) via a **tenant-identity** call (`/bitable/v1/apps/{app_token}/tables/{table_id}/records`, app permission `bitable:app`), keyed by `FEISHU_BITABLE_APP_TOKEN` + `FEISHU_BITABLE_TABLE_ID`.
- **The Coworker is the assignee, not a recipient.** Exactly one selected Feishu user is written into the row as the assigned handler. The app sends **no** message — no IM, no card, no webhook. Any alerting is Base's own.
- **Chat / bot / group / Doc / PDF / attachment paths retired.** The `forwardToFeishu` multi-target dispatch and the `bot.ts` / `chat.ts` / `docx.ts` / `pdf.ts` paths, the attachment + inline-image upload paths, and the `sentToBot` / `sentToChat` record fields are not part of live Base Sync. The code paths were removed; the old Email Record fields remain only for schema compatibility with historical rows.
- **User OAuth shrinks to coworker search.** The only user-token call left is Search Users (`/search/v1/user`, scope `contact:user:search`); `offline_access` stays for silent refresh. `im:chat:readonly` and `im:message` are dropped.

## Why

- **The real job is structured capture, not message delivery.** Sales wants every inbound inquiry as a queryable, assignable Base row — not another copy of the email in a chat. A row is filterable and reportable; a chat message is neither.
- **A tenant-token write removes the per-user dependency.** The Base write needs only the app's `bitable:app` permission — not the salesperson's chat scopes or a live IM session — so the sync is simpler and more reliable.
- **Less surface, less to break.** Dropping PDF rendering, multi-path media upload, and three delivery targets removes the bulk of the latency-critical, failure-prone code that ADR-0004/0005/0006 existed to manage.

## Consequences

- **ADR-0004, 0005, 0006 are superseded** — they govern machinery (binary-via-storage, text-only PDF, forward-latency parallelization) that no longer exists. **ADR-0003 is amended**: the scope set narrows to `contact:user:search` + `offline_access`; the Search Users decision itself still stands.
- **The redesigned UI is wired to this backend.** `RequestIntakeScreen` → `SyncScreen` calls `requestSync.syncRequest`; the progress animation is visual only and completion is controlled by the real action resolving.
- **Two new required env vars** (`FEISHU_BITABLE_APP_TOKEN`, `FEISHU_BITABLE_TABLE_ID`); without them the sync throws.
- **Base schema coupling.** The row's column names must exist in the target table or the write fails — the table schema is now part of the contract.
- **Existing users must re-authorize** once the requested scope set changes (Feishu grants only the scopes present at authorize time).

## Alternatives rejected

- **Keep all three targets, add Base as default.** Retains the maintenance burden (PDF, media, chat) for paths the product no longer uses — dead weight.
- **Notify the assigned coworker via IM/card.** Re-introduces the chat dependency and user scopes we're shedding; Base's own assignment notifications cover it.
- **Attach the email PDF / files to the Base row.** Deferred — adds a Drive/Base media path (the complexity ADR-0004 fought) for unclear value; the Body Preview field is enough for triage today.
