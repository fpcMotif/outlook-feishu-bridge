# Attachment picker UI (ADR-0022) — design

> Status: approved 2026-06-02. Completes the SPA half of [ADR-0022](../../adr/0022-attachments-and-mail-body-to-base-row.md). The backend (Feishu Drive `uploadAttachmentsToDrive`) and the SPA data path (`downloadMailAttachment` → `stageAndUploadAttachments` → `useAttachmentStaging`) are already built and tested; this adds the picker UI, its state, and the submit-time wiring.

## Goal

Let the salesperson attach files to the synced Base row from the intake screen:
(a) multi-select existing **mail attachments** (`selectableMailAttachments`: `attachmentType === "file" && !isInline`), and (b) **upload new files** (pdf / excel / word / image). Enforce **≤ 10 files** total and **≤ 20 MB/file**, with inline rejection reasons. Selected items stage to Convex File Storage, mint Feishu Drive `file_token`s, and ride `syncRequest`'s `attachments` arg into the single Base Attachment cell.

## Decisions (locked)

1. **Layout:** one unified `Attachments` section — mail attachments as checkbox rows, uploaded files as removable rows in the same list, an "Add file" row at the bottom; header shows `N / 10`.
2. **Default state:** mail attachments start **unchecked** (opt-in) — avoids accidentally uploading signature/logo files and keeps syncs lean.
3. **Failure policy:** **best-effort** — a download/upload failure for one attachment is logged and skipped; the sync proceeds with whatever staged. Matches ADR-0022 (attachments are best-effort on the immediate sync; reconcile drops them entirely). Attachments never gate submit.

## Units

### 1. `intakeReducer` state + actions (pure)
Add to `IntakeState`:
- `selectedAttachmentIds: string[]` — checked mail-attachment ids (default `[]`).
- `uploadedFiles: UploadedFile[]`, `UploadedFile = { id: string; file: File; rejection: string | null }`. The `id` (local uuid) and `rejection` (`uploadRejectionReason`) are computed in the component handler so the reducer stays pure.

Actions: `attachmentToggled {id}` (toggle in `selectedAttachmentIds`), `filesAdded {files}` (append), `uploadedFileRemoved {id}`. `startedOver` resets both new fields.

### 2. `attachmentSelection.ts` (pure helpers)
- `attachmentCount(selectedIds, uploads)` → checked + **valid** uploads (rejected uploads don't count).
- `canAddMore(count)` → `count < MAX_ATTACHMENT_COUNT`.
- Reuses `formatBytes`, `fileExtension`, `uploadRejectionReason`, `MAX_ATTACHMENT_COUNT` from `office/attachments.ts`. Over-limit toggles/adds are refused here so submit is never blocked by attachments.

### 3. `AttachmentSection.tsx` (presentational)
`TaskpaneSection` + `SectionLabel` ("Attachments  N / 10"); mail attachments as `ui/checkbox` rows (extension icon + name + `formatBytes`); uploaded files as rows with a ✕ remove button and inline `rejection` text; an "Add file" row driving a hidden `<input type="file" multiple accept="…">`. Props are the lists + handlers + count; no I/O. Rendered in `RequestIntakeScreen` between `NewRequestSection` and the dock.

### 4. `gatherAttachmentSources.ts` (best-effort orchestration)
`gatherAttachmentSources(downloadMail, selectedMail, uploads) → Promise<{ sources: AttachmentSource[]; failed: {name,reason}[] }>`. Each checked mail attachment is fetched via the injected `downloadMail` in a try/catch (failures collected, successes kept); uploaded `File`s become `{ name, blob: file }` directly (rejected uploads excluded). Injected `downloadMail` keeps it unit-testable.

### 5. Integration (`RequestIntakeScreen`)
`handleSubmit` becomes async: `dispatch(syncStarted)` (the existing "sync" overlay covers progress) → `gatherAttachmentSources` → `stageAndUploadAttachments(useAttachmentStaging(), sources)` → add `attachments` to the `runSync` payload → `sync()`. A new thin `useMailAttachmentDownloader()` hook closes over `Office.context.mailbox.item` and returns the `downloadMail` fn (no-op/throws in dev/browser hosts, which best-effort skips). Failed attachments are `console`-logged; no extra UI chip in v1.

### 6. Manifest
Bump the Mailbox requirement-set floor to **1.8** in `scripts/manifest.mjs` — the accepted ADR-0022 consequence of `getAttachmentContentAsync`.

## Testing
- `intakeReducer.test.ts`: toggle / filesAdded / remove / startedOver-reset transitions.
- `attachmentSelection.test.ts`: count excludes rejected uploads; `canAddMore` at the limit.
- `gatherAttachmentSources.test.ts`: mixed mail + uploads → ordered sources; a failing `downloadMail` → best-effort (kept successes, recorded failure).
- `AttachmentSection.test.tsx` (RTL): toggle a mail row, add a file with a rejection reason shown, remove an uploaded file, limit reached disables adding.
- `RequestIntakeScreen.sync.test.tsx`: with a checked attachment, `payload.attachments` carries the staged `[{ fileToken }]`.

## Out of scope (v1)
Drag-and-drop (Add-file button only), a received-screen "some attachments failed" chip, attachment metadata on the Email Record backup (ADR-0022 decision #5), and the chunked >20 MB upload path.
