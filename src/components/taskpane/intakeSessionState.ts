// Intake Session State — the ONE seam the pinned pane's per-conversation
// lifecycle goes through. A conversation's un-synced work (the intake draft:
// notes / Sales / Coworker / Customer picks, and the Upload draft: completed
// storageId metadata) survives pane switches and restores on return; this
// module owns that enter → leave → clear choreography, which previously lived
// as ordered cache calls scattered through useRequestIntakeScreen.
//
// The underlying stores keep their own documented identity scopes (CONTEXT.md
// "Upload draft" / "Single Feishu account per browser session") — this module
// composes them, it does NOT unify their keys:
//   - intake draft:  (openId · userEmail · mailKey)          — intakeDraftCache
//   - Upload draft:  (openId · userEmail · conversationId)   — uploadDraftCache
//   - the Request sync outbox snapshot (requestSyncSnapshot) is deliberately
//     NOT part of this module: it is identity-scoped WITHOUT openId and has an
//     internetMessageId fallback key — a different seam (useRequestSync).
//
// Lifecycle rules this module owns:
//   - RESTORE-ON-ENTER: rebuild the conversation's initial IntakeState from the
//     cached intake draft + rehydrated Upload draft (fresh state when none).
//   - LEAVE: a synced ("received") or already-cleared conversation drops both
//     drafts — its storageIds were consumed server-side, so a restored draft
//     would point at dead blobs. Anything else snapshots both, normalizing the
//     screen back to "build": the overlay screens (sync/error) are transient —
//     persisting screen:"sync" would resurrect a DEAD sync overlay on return
//     that never advances (the success dispatch is a no-op once the Core
//     unmounted).
//   - CLEAR-AFTER-SYNC: once the row exists, both drafts are dead; the session
//     remembers it cleared so a later leave() can never resurrect them.
//   - MAIL-SWITCH STAGING RESET: the per-upload-id staging Maps (inFlight /
//     completedStorage) are conversation-agnostic scratch state — they reset on
//     every switch and must NEVER touch the draft caches (the restore source).
//   - LOGOUT WIPE: draft Maps are SPA-session lifetime and the pinned pane
//     survives sign-out without a reload — wipe them so one user's selections /
//     file names + live storageIds never linger for the next account.

import {
  buildIntakeDraftKey,
  clearIntakeDraft,
  clearIntakeDraftCache,
  loadIntakeDraft,
  rememberIntakeDraft,
} from "./intakeDraftCache";
import {
  buildUploadDraftKey,
  clearUploadDraft,
  resetUploadDrafts,
  restoreUploadDraft,
  snapshotUploadDraft,
} from "./uploadDraftCache";
import { resetIntakeUploadCaches } from "./uploadIntakeFile";
import type { IntakeState, UploadedFile } from "./intakeReducer";

export interface IntakeSessionIdentity {
  /** Feishu account — required scoping on a shared Outlook mailbox. */
  openId?: string;
  /** Outlook mailbox (the shared identity, NOT the Feishu Initiator). */
  userEmail?: string;
  /** Email Conversation ID — the Upload draft's conversation scope. */
  conversationId?: string;
  /** deriveMailKey output — the intake draft's conversation scope. */
  mailKey: string;
}

/**
 * One conversation-mount's session handle. Open it once per Core mount (the
 * Core is keyed by mailKey, so identity is stable for the handle's lifetime).
 */
export interface IntakeSession {
  /**
   * Restore-on-enter: the conversation's initial IntakeState. `seededUploads`
   * (DEV fixture channel) bypasses the Upload draft when provided.
   */
  restore(mailFrom: string, seededUploads?: UploadedFile[]): IntakeState;
  /**
   * Leave choreography (unmount on a pinned-pane switch): drop both drafts for
   * a synced/cleared conversation, snapshot both (screen normalized to
   * "build", transient sync error dropped) for anything else.
   */
  leave(latestState: IntakeState): void;
  /**
   * Post-sync (local success or the server reporting synced-elsewhere): both
   * drafts are dead — clear them now and pin the session cleared.
   */
  clearDrafts(): void;
}

export function openIntakeSession(identity: IntakeSessionIdentity): IntakeSession {
  const uploadDraftKey = buildUploadDraftKey(
    identity.openId,
    identity.userEmail,
    identity.conversationId,
  );
  const intakeDraftKey = buildIntakeDraftKey(identity.openId, identity.userEmail, identity.mailKey);
  let cleared = false;
  return {
    restore(mailFrom, seededUploads) {
      const restoredUploads = seededUploads ?? restoreUploadDraft(uploadDraftKey);
      return loadIntakeDraft(intakeDraftKey, mailFrom, restoredUploads);
    },
    leave(latestState) {
      if (cleared || latestState.screen === "received") {
        clearUploadDraft(uploadDraftKey);
        clearIntakeDraft(intakeDraftKey);
        return;
      }
      snapshotUploadDraft(uploadDraftKey, latestState.uploadedFiles);
      rememberIntakeDraft(intakeDraftKey, {
        ...latestState,
        screen: "build",
        syncError: null,
      });
    },
    clearDrafts() {
      cleared = true;
      clearUploadDraft(uploadDraftKey);
      clearIntakeDraft(intakeDraftKey);
    },
  };
}

/**
 * Conversation-switch staging reset: clears ONLY the per-upload-id scratch Maps
 * (inFlight / completedStorage) — synchronously, before the keyed Core
 * remounts, so nothing from the previous conversation can mint into the new
 * one. Idempotent (StrictMode double-invoke is harmless). Must NEVER touch the
 * draft caches — they are the restore source.
 */
export function resetIntakeStagingForMailSwitch(): void {
  resetIntakeUploadCaches();
}

/** Logout wipe: every conversation's drafts, both stores, in one call. */
export function wipeIntakeSessionsOnLogout(): void {
  clearIntakeDraftCache();
  resetUploadDrafts();
}
