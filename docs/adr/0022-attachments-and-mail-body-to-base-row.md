# Attachments + mail body to the Base row, files staged via Convex File Storage

> **Update ([ADR-0027](0027-deferred-attachment-fill.md)):** three clauses below are revised — attachments no longer ride the **create** (the row is minted with an empty `Sales Files` cell and filled afterward by **Attachment Fill**); "all writes ride the create path only" now admits a deferred same-record attachment patch on a self-minted fresh row; "reconcile drops attachments" no longer holds (the fill replays from persisted sources); and the serial Drive upload is replaced by bounded concurrency. The mail-**body**-on-create decision here stands.

> **Status: accepted** (decisions grilled 2026-06-02). Reverses two clauses of [ADR-0010](0010-pivot-to-bitable-intake.md) — "the email **body** stays off the Base" and "attaching **files** to the Base row is deferred" — and **partially revives** the binaries-cross-via-Convex-File-Storage pattern of the retired [ADR-0004](0004-binaries-cross-via-convex-file-storage.md), now routed to Feishu **Drive** instead of the retired forward pipeline. All record writes still go through [ADR-0012](0012-bitable-record-api.md)'s create API and the no-touch-existing-rows rule. All six design decisions are resolved (see [Resolved decisions](#resolved-decisions)). The three live Base column names — initially **assumed** `Request Note` / `Email Body` / `Attachments` — were **confirmed against the live schema via `listFields` on 2026-06-03** and are in fact `Quotation Note` / `Email Content` / `Sales Files`. The assumed names had shipped and were failing every create with `1254045 FieldNameNotFound`; the constants in [serviceRow.ts](../../convex/feishu/serviceRow.ts) are now corrected. Two ⚠️ UNVERIFIED Feishu limits remain.

## Context

The add-in writes one **Base** Service row per synced email via `buildServiceFields()` ([serviceRow.ts](../../convex/feishu/serviceRow.ts)). Today it writes the request as **three** separate Text columns — `Quotation Note`, `Sample Note`, `R&D Support Note` — keeps the email **body** preview-only on the Convex **Email Record** (≤500 chars, never on Base), and writes **no attachments** (ADR-0010 deferred them when it retired the forward/PDF/Doc machinery of ADR-0004/0005/0006).

The product now wants three changes (the Base **table id is unchanged**):

1. **One consolidated note** column instead of three.
2. The plain-text **mail body** written into a Base column.
3. One Base **Attachment** column fed by (a) the open mail's existing attachments, multi-selected (all / none / some), and (b) user-uploaded new files (pdf, excel, docs, image).

**Unchanged, explicitly out of scope:** Coworker selection (exactly one — `requireExactlyOneCoworker`), Customer selection (CustomerPicker / Mirror / domain match), the forbidden `Request Type` write, the read-only Customer Table `tbl4TE2GV472sKzp`, and the no-touch rule on pre-existing rows.

## Decision

1. **Notes 3 → 1.** Replace the `NOTE_FIELD` 3-column map with a single consolidated note column. The SPA collapses the per-category notes into one string; `buildServiceFields` writes one note key.
2. **Body → Base.** Write the plain-text body (Office.js `CoercionType.Text`, which excludes attachments and inline images) into a new Base Text/long-text column. The ≤500-char Email Record preview stays for list views.
3. **Attachments → Base.** Path: SPA obtains bytes (Office.js `getAttachmentContentAsync` Base64 for existing mail attachments; a DOM `File`/`Blob` for uploads) → **Convex File Storage** (`generateUploadUrl` + client POST) → a dedicated Convex action (`uploadAttachmentsToDrive`) reads each staged `Blob`, uploads it to **Feishu Drive** `medias/upload_all` (`parent_type=bitable_file`, `parent_node=<app_token>`), deletes the staged storage object, and **returns the `file_token`(s) to the SPA**. The SPA then passes `attachments: [{ file_token }]` into `syncRequest`, and `buildServiceFields` writes them into the **one** Attachment cell on the record **create**. Minting the tokens *before* the create keeps the create idempotent — a `client_token` retry re-sends the same already-minted tokens, never re-uploading bytes. All writes ride the **create** path (plus the bounded same-flow correction); no pre-existing row is touched.

## The verified contract

Every endpoint/format below is cited to an official source — the standing rule for this repo (Feishu: open.feishu.cn + larksuite SDKs; Microsoft: learn.microsoft.com + OfficeDev; Convex: docs.convex.dev). Items no official page confirmed are flagged **⚠️ UNVERIFIED**.

### Convex File Storage (stage bytes; never inline them as action args)

- `ctx.storage.generateUploadUrl(): Promise<string>` — short-lived upload URL (**expires 1 h**). Client `POST`s raw bytes → `{ storageId: Id<"_storage"> }` (**no file-size limit on the POST**; 2-min timeout; optional `Digest` sha256 header).
- `ctx.storage.get(id): Promise<Blob | null>` (actions/HTTP actions only) — read staged bytes to forward to Feishu. `ctx.storage.delete(id)` after a successful upload. Metadata via `ctx.db.system.get("_storage", id)` (the deprecated `ctx.storage.getMetadata` is **not** used).
- Pass the handle as `v.id("_storage")`, never raw bytes: the **Node-runtime action-arg cap is 5 MiB** (default runtime 16 MiB), which a single PDF/Excel/image can exceed.
- Refs: https://docs.convex.dev/file-storage/upload-files · https://docs.convex.dev/api/interfaces/server.StorageActionWriter · https://docs.convex.dev/file-storage/serve-files · https://docs.convex.dev/file-storage/delete-files · https://docs.convex.dev/production/state/limits · https://docs.convex.dev/functions/runtimes · in-repo `convex/_generated/ai/guidelines.md`

### Feishu Drive media upload + Bitable attachment cell shape

- **Single-shot (≤ 20 MB):** `POST /open-apis/drive/v1/medias/upload_all`, `multipart/form-data` with `file_name`, `parent_type="bitable_file"`, `parent_node=<FEISHU_BITABLE_APP_TOKEN>` (the Base **app_token**, not record/table id), `size` (= byte length, ≤ `20971520`), `checksum` (Adler-32, **optional**), `file` (raw bytes). Response: `data.file_token`.
- **Rate limit (frequency control) — VERIFIED 2026-06-03.** `medias/upload_all` is capped at **5 QPS, 10 000/day** per app — quote from the endpoint doc: *"该接口调用频率上限为 5 QPS，10000 次/天"*. Exceeding it returns **HTTP 429** with the **gateway** code **`99991400` "request trigger frequency limit"** — note this code is NOT in the endpoint's own `1061xxx`/`1062xxx` error list (it is a generic gateway code), which is why it isn't found by searching the upload_all page. Uploading the staged files with a `Promise.all` tripped it live (`Uncaught FeishuError … code 99991400 … at async Promise.all (index 5)` — 6 concurrent > 5 QPS). Feishu's documented remedy is exponential backoff (*"建议使用指数退避算法"*). → [drive.ts](../../convex/feishu/drive.ts) now uploads attachments **serially** (one request in flight) and retries `99991400` with exponential backoff (`withDriveRateLimitRetry`, unit-tested). Strictly-correct future enhancement: honor the `x-ogw-ratelimit-reset` header returned on the 429 (per the frequency-control doc) instead of a fixed backoff.
- **Chunked (> 20 MB):** `upload_prepare` (returns `upload_id`, `block_size` = **4194304** fixed, `block_num`) → `upload_part` (`seq` **0-indexed**) → `upload_finish` (returns `file_token`).
- **Attachment field (type 17) WRITE shape** via the existing record-create API ([ADR-0012](0012-bitable-record-api.md)) — array of objects, **only `file_token` is load-bearing on write** (`name`/`type`/`size`/`url`/`tmp_url` are read-only):
  `{ "fields": { "<Attachment column>": [ { "file_token": "boxcn…" }, … ] } }`
- **Scope: no new scope.** `upload_all` accepts `bitable:app`, which the app already holds ([ADR-0011](0011-feishu-permission-set.md)); `parent_type=bitable_file` needs no `drive:drive`. The record write is also `bitable:app`. → **no user/app re-authorization for attachments.**
- **Transport already supported:** `CallFeishuOptions.form?: FormData` ([call.ts](../../convex/feishu/call.ts)) and `FeishuFetchOptions.form` ([client.ts](../../convex/feishu/client.ts)) are wired straight into `fetch` — the runtime sets the multipart boundary. A new `uploadMediaToDrive(ctx, blob, fileName, appToken)` helper just builds the `FormData`.
- **⚠️ UNVERIFIED:** per-cell attachment **count** limit, per-Base attachment **storage cap**, and the `extra` JSON required only when the Base has **advanced permissions** (SDK-sourced).
- Refs: https://open.feishu.cn/document/server-docs/docs/drive-v1/media/upload_all (the **5 QPS / 10 000-per-day** cap is stated here) · https://open.feishu.cn/document/server-docs/api-call-guide/generic-error-code (code **99991400** "request trigger frequency limit" → use exponential backoff) · https://open.feishu.cn/document/server-docs/api-call-guide/frequency-control (HTTP 429 + `x-ogw-ratelimit-reset`) · https://open.feishu.cn/document/server-docs/docs/drive-v1/media/multipart-upload-media/upload_prepare · https://open.feishu.cn/document/docs/bitable-v1/app-table-record/bitable-record-data-structure-overview · https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/create · `larksuite/oapi-sdk-go` (`ParentTypeUploadAllMediaBitableFile = "bitable_file"`) · `larksuite/node-sdk`

### Office.js — body + attachments

- **Plain-text body:** `item.body.getAsync(Office.CoercionType.Text, …)` (requirement set **Mailbox 1.1**) — already wrapped in [src/office/mailBody.ts](../../src/office/mailBody.ts). Text coercion returns the textual body only (no attachments/inline images). **⚠️ QA caveats:** whitespace/newline fidelity varies on Outlook-web / new-Windows; a **reply** may return the whole thread unless `bodyMode` restricts it; `getAsync` is unsupported on Android/iOS.
- **Enumerate attachments (no network):** `item.attachments → AttachmentDetails[]` (`id`, `name`, `attachmentType` `"file"|"cloud"|"item"`, `size`, `isInline`, `contentId`; `contentType` is **deprecated** — derive type from the filename extension). Requirement set **Mailbox 1.1**; already read in [src/office/mailItem.ts](../../src/office/mailItem.ts). **Selectable list = filter `attachmentType === "file" && !isInline`** (drops inline images + cloud/item types).
- **Download bytes:** `item.getAttachmentContentAsync(attachmentId, …) → AttachmentContent { format, content }`; file attachments arrive as `format === Base64`. **Requirement set Mailbox 1.8** (this **raises the manifest floor to 1.8**); **cap 25 MB** pre-Base64. **⚠️ Handle:** `AttachmentTypeNotSupported`, `InvalidAttachmentId`, session-bound attachment ids on web/new-Windows, unsupported on Android/iOS.
- **Uploaded new files** are plain DOM `File`/`Blob` (no Office.js). Both sources normalize to `{ name, mimeType (from extension), blob }` and feed the identical bytes → Convex storage → Drive → `file_token` path.
- Refs: https://learn.microsoft.com/en-us/javascript/api/outlook/office.body · https://learn.microsoft.com/en-us/javascript/api/outlook/office.attachmentdetails · https://learn.microsoft.com/en-us/javascript/api/outlook/office.attachmentcontent · https://learn.microsoft.com/en-us/office/dev/add-ins/outlook/get-attachments-of-an-outlook-item · https://learn.microsoft.com/en-us/office/dev/add-ins/outlook/limits-for-activation-and-javascript-api-for-outlook-add-ins

## Field audit after this change

The add-in writes **9 columns** via Convex (the 3 note columns collapse to 1; body + attachment are new):

| # | Bitable column | Status | Value shape | Feishu type |
|---|---|---|---|---|
| 1 | `Quotation Note` | **changed** (3→1) | `string` | Text (1) |
| 2 | `Co Worker` | unchanged | `[{ id: openId }]` | User (11) |
| 3 | `Date of Offer` | unchanged | epoch-ms `number` | DateTime (5) |
| 4 | `Client` | unchanged | `[recordId]` | DuplexLink (21) |
| 5 | `Email Subject` | unchanged | `string` | Text (1) |
| 6 | `Sales` | unchanged | `[{ id: openId }]` | User (11) |
| 7 | `Email Conversation ID` | unchanged | `string` | Text (1) |
| 8 | `Email Content` | **new** | `string` | Text (1) |
| 9 | `Sales Files` | **new** | `[{ file_token }]` | **Attachment (17)** |

**Forbidden (never written):** `Request Type` (MultiSelect — Feishu-owned), `Business Branch` / `Service Type` (manual in Bitable), the Customer Table (read-only), any pre-existing row (no-touch rule).

## Consequences

- **Schema coupling (hard).** The three new/changed columns must already exist in the live Base with the **exact** names we write — the add-in cannot create columns; a wrong/missing name fails the create or silently drops the field. Names are [open decision #1](#open-decisions-blocking). Run `listFields` ([bitable.ts](../../convex/feishu/bitable.ts)) against the live table to confirm.
- **Manifest floor rises to Mailbox 1.8** (driven by `getAttachmentContentAsync`).
- **No new Feishu scope, no re-auth** (`bitable:app` covers Drive `upload_all` for `bitable_file`). Confirm against the live permission set; if the Base uses **advanced permissions**, the ⚠️ UNVERIFIED `extra` field becomes required.
- **Storage hygiene.** `uploadAttachmentsToDrive` deletes each staged storage object after a successful Feishu upload. Because `file_token`s are minted *before* `syncRequest` and the create is idempotent (`client_token`), an immediate retry re-sends the same tokens — never re-uploading bytes or duplicating the row.
- **Reconcile drops attachments (known v1 limitation).** The outbox/reconcile path ([ADR-0018](0018-request-sync-outbox-and-reconcile.md)) rebuilds the row from the pending **Email Record**, which by [decision #5](#resolved-decisions) stores **no attachment metadata** (and no full body). So if the immediate create fails after staging and the row is later reconciled, it lands with the body **preview** and **no attachments** — best-effort attachments on the immediate sync only; logged when it happens.
- **No-touch rule holds.** Body/attachment writes ride the create path only.

## Alternatives rejected

- **Microsoft Graph to fetch attachment bytes** — off-limits per [ADR-0015](0015-m365-office-js-official-sources.md) unless ADR-scoped; `getAttachmentContentAsync` covers Mailbox ≥ 1.8.
- **Direct browser → Feishu Drive upload (skip the Convex relay)** — not possible. `medias/upload_all` is a server-side API requiring a `Bearer` **tenant**_access_token (app-secret-derived; must stay server-side, ADR-0011) or user_access_token, and Feishu open-platform endpoints are server-to-server (the official doc shows no browser/CORS path). The SPA holds neither a Drive-scoped token nor a CORS route; a 20 MB file also exceeds Convex's 5 MiB action-arg cap. So both mail-attachment bytes and uploaded-file bytes must relay through Convex File Storage → a tenant-token action → Drive. (https://open.feishu.cn/document/server-docs/docs/drive-v1/media/upload_all — auth + scope list confirm `bitable:app`.)
- **Base64-inline bytes as Convex action args** — breaks the 5 MiB Node-runtime cap; staged upload URLs have no size limit.
- **`drive:drive` / `drive:media` scope** — unnecessary; `bitable:app` is accepted by `upload_all`.
- **Keep three note columns** — contradicts the spec.

## Resolved decisions

Grilled 2026-06-02. These pin the design; `/tdd` follows.

1. **Categories dropped entirely.** Quotation / Sample / R&D Support are retired as a typed set — the UI is already a single note box ([RequestCards.tsx](../../src/components/taskpane/RequestCards.tsx) renders only the primary card). One note → one `Quotation Note` column. The `REQUESTS` map + `NOTE_FIELD` 3-column routing are deleted.
2. **Live Base column names: CONFIRMED via `listFields` (2026-06-03).** The assumed names (`Request Note` / `Email Body` / `Attachments`) were **wrong** — none existed in the live Service table, so every create failed with `1254045 FieldNameNotFound` (Feishu reports only the first offending field, which masked that all three were wrong). The real columns are `Quotation Note` (Text 1), `Email Content` (Text 1), and `Sales Files` (Attachment 17) — centralized as named constants in [serviceRow.ts](../../convex/feishu/serviceRow.ts). **Lesson:** "confirm against the live schema before the first production write" is load-bearing, not optional — run `listFields` whenever a column name is added or changed.
3. **Body: full, no product cap.** Write the full plain-text body verbatim — no truncation, no marker. The earlier worry about pathologically long bodies (a reply returning the whole quoted thread) is **refuted by the domain**: the add-in syncs a single *received* inquiry message (compose/reply items are already rejected), so bodies are normal-sized. Bitable Text (type 1) holds multi-line text; Convex's ~1 MiB single-value limit is a non-issue for one inbound email, so no special handling. The ≤500-char Email Record preview is unchanged.
4. **Attachments: ≤ 20 MB/file, single-shot only, max 10.** Enforce ≤ 20 MB per file client-side → use only `medias/upload_all` (no chunked path in v1). Cap total at **10** files pending the ⚠️ UNVERIFIED per-cell limit. **Uploads** are filtered to pdf / excel / docs / image by extension; **existing mail attachments** are offered as-is (already filtered to `attachmentType === "file" && !isInline`).
5. **Email Record backup: consolidate the note only; no attachment metadata.** Store one `requestNote` string (stop writing the 3-entry `requestSelections`; keep it optional in the schema so historical rows stay valid). The backup does **not** record synced attachments — attachments live only in the Base cell. The ≤500-char body preview stays. **Identity rule:** the record's business identity is the **(conversationId + Initiator email)** pair — `conversationId` alone is *not* unique (it is mailbox-local and thread-level). Per-sync idempotency is unaffected: it keys on the globally-unique `internetMessageId`, as today.
6. **No new Feishu scope, no re-authorization.** `bitable:app` ([ADR-0011](0011-feishu-permission-set.md)) is the only tenant scope and is accepted by Drive `upload_all` for `parent_type=bitable_file`. Confirmed from the granted scope set. **⚠️ Confirm before deploy:** if the live Base uses *advanced permissions*, the UNVERIFIED `extra` multipart field becomes required.
