// Fixture factory that mimics the Outlook taskpane "send/confirm" intake — the
// exact args shape `syncRequest` (and `processPendingBitableSync`) consume. It
// also stages each attachment's bytes into the harness FakeStorage, so the
// deferred Attachment Fill has real blobs to mint Drive tokens from.
//
// Coworker open_ids must be REAL (non dev-preview), or poisonedOutboxReason /
// assertRealCoworkerOpenIds abandons the row before any Base call — the default
// coworker here is a 40-hex-char Person id that passes both gates.
//
// Pure TypeScript: NO `vitest` import.

import type { FakeStorage } from "./fakeConvex";

/** One staged attachment as it lands in `attachmentSources`. */
export interface IntakeAttachment {
  storageId: string;
  fileName: string;
}

/** A real (non dev-preview) Feishu coworker the Base create accepts. */
export interface IntakeCoworker {
  openId: string;
  name: string;
  avatarUrl?: string;
}

/** The full intake args, matching requestSync's `intakeArgs`. */
export interface OutlookIntake {
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  body: string;
  internetMessageId: string;
  itemId?: string;
  conversationId?: string;
  userEmail?: string;
  dateTimeCreated?: number;
  clientEmail?: string;
  selectedCustomer?: { recordId: string; name: string };
  selectedSales?: { openId: string; name?: string };
  initiator?: { openId: string; name?: string };
  requestNote?: string;
  attachments?: { fileToken: string }[];
  attachmentSources?: IntakeAttachment[];
  selectedCoworkers?: IntakeCoworker[];
}

/** A valid, real Feishu Person open_id (40 hex chars) the Base create accepts. */
export const DEFAULT_COWORKER: IntakeCoworker = {
  openId: "ou_1fa1e520f980675ed46ff40aa177a488",
  name: "Jenny Xu",
};

/** A valid Sales/initiator open_id (real shape, not a dev preview id). */
export const DEFAULT_SALES = {
  openId: "ou_0a1b2c3d4e5f60718293a4b5c6d7e8f9",
  name: "Rep One",
};

let intakeSeq = 0;

export interface MakeIntakeOptions {
  /** Override any intake field directly. */
  overrides?: Partial<OutlookIntake>;
  /**
   * How many attachment sources to stage (each gets unique bytes + fileName +
   * storageId). Ignored when `overrides.attachmentSources` is provided.
   */
  attachmentCount?: number;
  /** Bytes-per-staged-blob (default 8). Use a large value for oversize tests. */
  bytesPerAttachment?: number;
  /** Explicit fileNames for staged attachments (length wins over attachmentCount). */
  fileNames?: string[];
}

/**
 * Build a fresh intake. Every call gets a unique conversation / message id (so
 * the requestSyncKey is distinct) and stages `attachmentCount` blobs into the
 * given FakeStorage, wiring their storageIds into `attachmentSources`.
 *
 * The returned object is the literal args for `syncRequest._handler`.
 */
export function makeIntake(
  storage: FakeStorage,
  options: MakeIntakeOptions = {},
): OutlookIntake {
  intakeSeq += 1;
  const n = intakeSeq;
  const {
    overrides = {},
    attachmentCount = 0,
    bytesPerAttachment = 8,
    fileNames,
  } = options;

  const userEmail = overrides.userEmail ?? `rep${n}@fenchem.com`;
  const conversationId = overrides.conversationId ?? `conv-${n}`;

  const stagedSources =
    overrides.attachmentSources ??
    stageAttachments(storage, n, { attachmentCount, bytesPerAttachment, fileNames });

  return {
    subject: overrides.subject ?? `Need quote ${n}`,
    from: overrides.from ?? `buyer${n}@acme-customer.com`,
    to: overrides.to ?? [`sales${n}@fenchem.com`],
    cc: overrides.cc ?? [],
    body: overrides.body ?? `Please quote item ${n}. Full body text.`,
    internetMessageId: overrides.internetMessageId ?? `<msg-${n}@acme-customer.com>`,
    itemId: overrides.itemId ?? `item-${n}`,
    conversationId,
    userEmail,
    dateTimeCreated: overrides.dateTimeCreated ?? 1_716_000_000_000 + n,
    clientEmail: overrides.clientEmail ?? `buyer${n}@acme-customer.com`,
    selectedCustomer: overrides.selectedCustomer,
    selectedSales: overrides.selectedSales ?? DEFAULT_SALES,
    initiator: overrides.initiator,
    requestNote: overrides.requestNote ?? `quote ${n}`,
    attachments: overrides.attachments,
    attachmentSources: stagedSources,
    selectedCoworkers: overrides.selectedCoworkers ?? [DEFAULT_COWORKER],
  };
}

/**
 * Stage `attachmentCount` (or `fileNames.length`) blobs into storage with unique
 * bytes + fileNames + storageIds, returning the `attachmentSources` array.
 */
export function stageAttachments(
  storage: FakeStorage,
  intakeIndex: number,
  opts: { attachmentCount?: number; bytesPerAttachment?: number; fileNames?: string[] } = {},
): IntakeAttachment[] {
  const names =
    opts.fileNames ??
    Array.from({ length: opts.attachmentCount ?? 0 }, (_unused, i) => `file-${intakeIndex}-${i + 1}.pdf`);
  const byteLen = opts.bytesPerAttachment ?? 8;
  return names.map((fileName, i) => {
    const bytes = makeBytes(byteLen, intakeIndex * 100 + i + 1);
    const storageId = storage.stage(bytes, `kg_${intakeIndex}_${i + 1}`);
    return { storageId, fileName };
  });
}

/** A deterministic, distinct ArrayBuffer of `len` bytes seeded by `seed`. */
export function makeBytes(len: number, seed: number): ArrayBuffer {
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) arr[i] = (seed + i) & 0xff;
  return arr.buffer;
}

/** Reset the monotonic intake counter (call between unrelated test suites if needed). */
export function resetIntakeSeq(): void {
  intakeSeq = 0;
}
