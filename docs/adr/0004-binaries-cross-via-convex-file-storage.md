# Binary payloads cross SPA → Convex via File Storage, never as function arguments

> **Status: superseded by [ADR-0010](0010-pivot-to-bitable-intake.md).** Historical — the PDF / attachment / Feishu-Doc upload paths this manages are retired in the Base-intake pivot; kept for context.

Forwarding an email ships a rendered **PDF** plus the mail's **attachments** / inline images to Feishu. Convex **Node**-action arguments are capped at **5 MiB** (V8 actions at 16 MiB), and an ordinary attachment (or the old raster PDF) easily exceeds that — passing bytes as an action argument fails with *"Node actions arguments size is too large."* So any binary that **can be large** takes the storage path: the SPA uploads it to **Convex File Storage** via `generateUploadUrl()` (a plain HTTP POST, no arg-size cap) and passes only the tiny `storageId` to the action, which reads the bytes back with `getStorageBytes`, uploads to Feishu, then deletes the staged file. This is how **attachments**, **inline images** (`fileUpload.ts`, `imageUpload.ts`), and **large** PDFs travel.

### The small text PDF is the exception — it rides inline (measured)

Staging is **two extra CN→US round-trips** (`generateUploadUrl` + the upload POST) plus a server-side `getStorageBytes` read. For a real Case-A forward we measured that costing **~3 s for a ~5 KB PDF** (client `stage` 2311 ms + server `[storage] read` 673 ms) — pure latency, zero payoff for a tiny file. Since ADR-0005 made the PDF **text-only** (a few KB; it was the raster PDF that blew the 5 MiB cap), the client passes a small PDF (**≤ `PDF_INLINE_MAX`, 4 MiB**) **inline as `pdfBytes`** straight to the **`forwardToFeishu`** action, which uploads it to Feishu **server-side**. That also **collapses a round-trip**: the whole forward is now one CN→US call, instead of a separate client `uploadPdf` call *then* `forwardToFeishu` (the earlier measurement showed the separate upload + the staging together dominating Case A). A larger PDF is staged in storage first and passed as a `pdfStorageId`. `uploadPdfToFeishu` (now an internal action) accepts **either** `pdfBytes` **or** a `storageId`; the 4 MiB threshold sits under the 5 MiB Node-action cap.

## Ceilings this leaves

- **Feishu IM file** (`/im/v1/files`): **30 MB**; **IM image** (`/im/v1/images`): **10 MB**. These — not Convex's 5 MiB — are now the real limits for inline forwarding.
- Files **> 30 MB** can't be sent **inline** to a chat; they're **embedded in the Feishu Doc** instead (see below), and the orchestration surfaces anything still too big rather than dropping it silently.

## > 20 MB attachments → embedded in the Feishu Doc (chunked media upload)

Feishu **Drive media** is not standalone file hosting — it must hang off a parent cloud doc (`parent_node` is required; the official spec says `ccm_import_open` is import-only, not standalone). So large attachments ride in the **Feishu Doc** the forward already creates: `docx.ts`'s media upload now uses `medias/upload_all` (≤ 20 MB) or the **chunked** flow `upload_prepare` → `upload_part` (`block_size`-byte blocks — 4 MB — with `seq` 0-indexed) → `upload_finish` (> 20 MB), scope `docs:document.media:upload` (already enabled). This also fixed a latent bug: 20–30 MB doc attachments previously failed at `upload_all`'s 20 MB cap. Doc attachments are now allowed up to ~50 MB, bounded in practice by Outlook's `getAttachmentContentAsync` limit.

A standalone chat link — a 24 h `medias/batch_get_tmp_download_url` (scope `docs:document.media:download`, enabled) posted as a card button — is the remaining option, deferred pending a live test. A *public* Drive-file share is not used: it needs `drive:drive`, which the app lacks.
