# Per-conversation upload-draft restore + per-file Drive fault tolerance

> **Status: accepted.** Builds on [ADR-0022](0022-attachments-and-mail-body-to-base-row.md) (attachment staging) and the pinned-pane conversation-scoped reset ([ADR-0025](0025-sales-reassignable-account-owner.md) neighbourhood).

## Context

With the task pane **pinned**, switching to a different **Email Conversation** remounts the intake tree and clears `uploadedFiles`. A salesperson who uploaded files to conversation A, glanced at B, and returned to A lost their un-synced uploads — even though the bytes already persist in Convex File Storage by `storageId`. Restore is therefore cheap (cache *references*, not bytes), but the adversarial review surfaced two backend realities that make naive restore dangerous:

1. **`uploadAttachmentsToDrive` deletes each `storageId` after a successful Drive mint** (`ctx.storage.delete`), so a draft snapshotted from an already-**synced** conversation points at dead blobs.
2. **A dead/GC'd `storageId` did not soft-fail** — `getStorageBytes` throws, and with no per-file `try/catch` the throw bubbled to `runSync`'s `.catch` → `syncFailed`, **discarding the user's typed notes and every other attachment**.

## Decision

- **Per-conversation `Upload draft` cache** (`uploadDraftCache.ts`, in-memory for the SPA session). Keyed by **`openId` + `userEmail` + `conversationId`** — the `openId` prefix is required because `userEmail` is the *shared Outlook mailbox*, not the Feishu identity. Only **completed** uploads (status `complete` + `storageId`) are cached, as JSON-serializable metadata (`{ name, size, mime, storageId, selected }`), capped at `MAX_ATTACHMENT_COUNT`.
- **Snapshot on leave / restore on return.** An unmount-cleanup effect snapshots the leaving conversation's uploads (read from reducer state, which carries `storageId` — immune to the parent clearing the per-id `completedStorage`). Restore happens via the **`useReducer` lazy initializer** (StrictMode-safe; a dispatch would double-append). A restored row syncs from its `storageId` with no re-upload; its `File` is a stub carrying the real `name`/`size`.
- **Clear, never restore, a synced conversation.** On sync success (`runSync` + the `received` screen on unmount) the draft is cleared, because its `storageId`s are now consumed/deleted.
- **`uploadAttachmentsToDrive` is per-file fault-tolerant.** A file whose `storageId` 404s (or exceeds 20 MB) is **skipped** and returned in a `skipped: string[]` list; the Base row is still created with the tokens that minted. An attachment failure must never flip the sync to `syncFailed`. `skipped` flows to the SPA as a soft `failed` entry (existing logging).
- **Logout wipes the draft Map** (`resetUploadDrafts` in `useFeishuAuth`), since the pinned pane survives sign-out without a reload.

## Consequences

- `uploadAttachmentsToDrive`'s return shape gains `skipped`; `AttachmentStagingDeps.uploadToDrive` and `stageAndUploadAttachments` change accordingly (one live SPA consumer).
- `resetIntakeUploadCaches` (per-id) must **not** touch the draft cache (per-conversation) — it is the restore source (guard comment in `RequestIntakeScreen.tsx`).

## Deferred

- **No "restored / unverified" badge and no on-restore liveness probe** in v1: a restored row whose `storageId` dies between restore and sync is silently skipped (logged, not flagged). Acceptable because clear-on-sync removes the dominant dead case.
- **localStorage promotion** (cross-reload persistence) is gated on keeping the `openId` in the persisted key + the logout wipe + a TTL/cap — else the session-lifetime leak becomes a durable cross-reload one. In-memory only for now.
