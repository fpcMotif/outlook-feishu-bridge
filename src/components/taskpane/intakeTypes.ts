// Types for the one-screen Base Sync intake state machine (ADR-0022). Split from
// intakeReducer.ts to keep that module's logic under the file line cap;
// intakeReducer re-exports these so existing `from "./intakeReducer"` imports
// keep working.

import type { Coworker } from "./coworkers";
import type { CustomerRecord } from "./customers";

export type IntakeScreenName = "build" | "sync" | "received" | "error";

export type SelfForwardStatus = "pending" | "ok" | "failed" | null;

export type UploadStatus =
  | "pending"
  | "uploading"
  | "processing"
  | "complete"
  | "error";

// A user-uploaded file staged for the Base Attachment cell (ADR-0022). `id` is a
// local uuid (minted in the picker handler), `rejection` is the inline reason
// from uploadRejectionReason (null = acceptable). The DOM File carries the bytes.
// Valid picks upload to Convex File Storage eagerly; `status` / `progress` drive
// the row UI and `storageId` skips re-upload at sync time when complete.
export interface UploadedFile {
  id: string;
  file: File;
  rejection: string | null;
  selected: boolean;
  status?: UploadStatus;
  progress?: number;
  storageId?: string;
  uploadError?: string | null;
}

export interface IntakeState {
  notes: Record<string, string>;
  clientEmail: string;
  mailFrom: string;
  screen: IntakeScreenName;
  selectedCoworker: Coworker | null;
  selectedSales: Coworker | null;
  salesTouched: boolean;
  selectedCustomer: CustomerRecord | null;
  customerTouched: boolean;
  bitableRecordId: string | null;
  bitableDetailUrl: string | null;
  syncError: string | null;
  selfForwardStatus: SelfForwardStatus;
  selfForwardError: { code: string; message: string } | null;
  // ADR-0022 attachments: checked mail-attachment ids (opt-in, default []) and
  // the user's uploaded files. Sources are gathered + staged at submit time.
  selectedAttachmentIds: string[];
  /** Outlook mail attachment ids hidden via row remove (still on the message). */
  dismissedMailAttachmentIds: string[];
  uploadedFiles: UploadedFile[];
}

export type IntakeAction =
  | { type: "mailFromChanged"; mailFrom: string }
  | { type: "noteChanged"; id: string; value: string }
  | { type: "screenChanged"; screen: IntakeScreenName }
  | { type: "coworkerSelected"; coworker: Coworker }
  | { type: "salesSelected"; sales: Coworker }
  | { type: "salesDefaulted"; sales: Coworker }
  | { type: "customerAutoMatched"; customer: CustomerRecord | null }
  | { type: "customerOverridden"; customer: CustomerRecord | null }
  | { type: "syncStarted" }
  | { type: "syncQueued" }
  | { type: "syncSucceeded"; recordId: string; detailUrl?: string | null }
  | { type: "syncFailed"; message: string }
  | { type: "selfForwardStarted" }
  | { type: "selfForwardSucceeded" }
  | { type: "selfForwardFailed"; code: string; message: string }
  | { type: "attachmentToggled"; id: string }
  | { type: "mailAttachmentRemoved"; id: string }
  | { type: "filesAdded"; files: UploadedFile[] }
  | { type: "uploadedFileToggled"; id: string }
  | { type: "uploadedFilesSelectionChanged"; ids: string[] }
  | { type: "uploadedFileRemoved"; id: string }
  | { type: "uploadProgressUpdated"; id: string; progress: number }
  | {
      type: "uploadStatusChanged";
      id: string;
      status: UploadStatus;
      progress?: number;
      storageId?: string;
      uploadError?: string | null;
    }
  | { type: "uploadRetryRequested"; id: string }
  | { type: "startedOver" };
