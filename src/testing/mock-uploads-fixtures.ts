// DEV-ONLY mock-upload fixtures ("constra mode") for reproducing the failed /
// retry / re-add attachment UI in `bun run dev` without a real Office host or a
// real network failure. Seeded into the intake reducer via the same
// `restoredUploads` channel production restore uses, and gated on
// import.meta.env.DEV at every call site (TaskPane / useRequestIntakeScreen), so
// it is unreachable in a production build even if someone appends `?mock=`.
//
// Trigger: open `/?mock=failed-uploads` (pair with `?devUser=1` to skip login).

import {
  UNREADABLE_FILE_MESSAGE,
  type AttachmentStagingDeps,
} from "../office/attachmentUpload";
import type { UploadedFile } from "../components/taskpane/intakeReducer";

export type MockUploadsMode = "failed-uploads" | "failed-uploads-then-ok";

export function isMockUploadsMode(v: string | null): v is MockUploadsMode {
  return v === "failed-uploads" || v === "failed-uploads-then-ok";
}

const NETWORK_ERROR = "Convex storage upload failed (network)";

// A tiny PNG-typed DOM File with a realistic-looking size for the row label.
function fakePng(name: string, size: number): File {
  const file = new File([new Uint8Array(8)], name, {
    type: "image/png",
    lastModified: 0,
  });
  Object.defineProperty(file, "size", { value: size, configurable: true });
  return file;
}

// 12 network-failed PNGs. Each keeps selected:true to prove the row is PARKED,
// not staged (occupiesSlot ignores status "error"), reproducing the original
// "selected but failed" trap that no longer counts against the limit.
function mockNetworkFailedRows(): UploadedFile[] {
  return Array.from({ length: 12 }, (_, i) => ({
    id: `mock-net-${i}`,
    file: fakePng(`企业微信截图_2026051${i}.png`, 150_000 + i * 1000),
    rejection: null,
    selected: true,
    status: "error",
    progress: 0,
    uploadError: NETWORK_ERROR,
  }));
}

// One row of every non-network state: an unreadable cloud pick (shows Re-add via
// isUnreadableUploadError), a complete pick, an in-flight pick, and a rejection.
function mockOtherRows(): UploadedFile[] {
  return [
    {
      id: "mock-unreadable",
      file: fakePng("OneDrive-photo.png", 240_000),
      rejection: null,
      selected: true,
      status: "error",
      progress: 0,
      uploadError: UNREADABLE_FILE_MESSAGE,
    },
    {
      id: "mock-complete",
      file: fakePng("approved-quote.png", 90_000),
      rejection: null,
      selected: true,
      status: "complete",
      progress: 100,
      storageId: "kg_mock_complete",
      uploadError: null,
    },
    {
      id: "mock-uploading",
      file: fakePng("in-progress.png", 320_000),
      rejection: null,
      selected: true,
      status: "uploading",
      progress: 45,
      uploadError: null,
    },
    {
      id: "mock-rejected",
      file: fakePng("too-big.exe", 99_000_000),
      rejection: "unsupported type",
      selected: false,
    },
  ];
}

// A representative batch reproducing the reported screenshot (many PNGs all
// FAILED) plus one row of every other state, so the whole failed/retry/re-add UI
// — per-row Retry, Re-add, the skip notice, slot accounting (failed rows don't
// count), progress, and a rejection — renders at once.
export function buildMockUploadedFiles(mode: MockUploadsMode): UploadedFile[] {
  const failed = mockNetworkFailedRows();
  const [unreadable, complete, uploading, rejected] = mockOtherRows();
  if (mode === "failed-uploads-then-ok") {
    return [complete, failed[0], failed[1], uploading];
  }
  return [...failed, unreadable, complete, uploading, rejected];
}

// Deterministic staging deps for Retry under the mock, so a developer can watch
// the retry flow without a backend. generateUploadUrl is the single network
// boundary uploadBlobWithRetry depends on:
//  - "failed-uploads": always throws the tagged transport error, so Retry runs
//    the real backoff loop and the row lands back in error (reproduces the bug).
//  - "failed-uploads-then-ok": fails the first attempt, then resolves and
//    uploadBytes returns a fake storageId, so Retry visibly recovers.
export function buildMockStagingDeps(mode: MockUploadsMode): AttachmentStagingDeps {
  const transport = () => {
    const err = new Error(NETWORK_ERROR);
    // Matches isRetryableUploadError so the real backoff loop engages on Retry.
    err.name = "ConvexUploadTransportError";
    return err;
  };
  let attempts = 0;
  return {
    generateUploadUrl: () => {
      attempts += 1;
      if (mode === "failed-uploads") return Promise.reject(transport());
      if (attempts <= 1) return Promise.reject(transport());
      return Promise.resolve("https://mock.invalid/upload");
    },
    uploadBytes: () => Promise.resolve({ storageId: `kg_mock_${attempts}` }),
  };
}
