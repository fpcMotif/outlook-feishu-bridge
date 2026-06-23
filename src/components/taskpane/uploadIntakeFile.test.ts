import { beforeEach, describe, expect, it, vi } from "vitest";

import { initialIntakeState, intakeReducer } from "./intakeReducer";
import {
  awaitIntakeUploads,
  clearIntakeUploadCache,
  intakeUploadInFlight,
  queueIntakeFileUploads,
  resetIntakeUploadCaches,
  uploadIntakeFileToStorage,
} from "./uploadIntakeFile";
import { UPLOAD_CONCURRENCY } from "./runWithConcurrency";

vi.mock("../../office/attachmentUpload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../office/attachmentUpload")>();
  return {
    ...actual,
    postBytesToConvexWithProgress: vi.fn(),
    // Stub the byte read so tests never hit real File.arrayBuffer() or the
    // hydration-retry timers; each test sets resolve/reject behaviour it needs.
    readFileBytesWithRetry: vi.fn(),
  };
});

vi.mock("../../sentry", () => ({ reportUploadError: vi.fn() }));

import {
  postBytesToConvexWithProgress,
  readFileBytesWithRetry,
  UNREADABLE_FILE_MESSAGE,
} from "../../office/attachmentUpload";
import { reportUploadError } from "../../sentry";

describe("uploadIntakeFileToStorage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readFileBytesWithRetry).mockResolvedValue(new ArrayBuffer(1));
    clearIntakeUploadCache("u1");
  });

  it("dispatches uploading, progress, and complete transitions", async () => {
    vi.mocked(postBytesToConvexWithProgress).mockImplementation(
      async (_url, _blob, onProgress) => {
        onProgress?.(25);
        onProgress?.(100);
        return { storageId: "st_1" };
      },
    );

    let state = initialIntakeState("a@b.com");
    const dispatch = (action: Parameters<typeof intakeReducer>[1]) => {
      state = intakeReducer(state, action);
    };
    state = intakeReducer(state, {
      type: "filesAdded",
      files: [
        {
          id: "u1",
          file: new File(["x"], "a.pdf"),
          rejection: null,
          selected: true,
          status: "pending",
          progress: 0,
        },
      ],
    });

    await uploadIntakeFileToStorage(
      { generateUploadUrl: vi.fn().mockResolvedValue("https://up/1") },
      { id: "u1", file: new File(["x"], "a.pdf") },
      dispatch,
    );

    expect(state.uploadedFiles[0]).toMatchObject({
      status: "complete",
      progress: 100,
      storageId: "st_1",
    });
    expect(postBytesToConvexWithProgress).toHaveBeenCalled();
  });

  it("does not reset progress when a duplicate start races the same id", async () => {
    let resolveUpload!: () => void;
    const uploadDone = new Promise<{ storageId: string }>((resolve) => {
      resolveUpload = () => resolve({ storageId: "st_1" });
    });
    vi.mocked(postBytesToConvexWithProgress).mockImplementation(
      async (_url, _blob, onProgress) => {
        onProgress?.(30);
        await uploadDone;
        onProgress?.(100);
        return { storageId: "st_1" };
      },
    );

    let state = initialIntakeState("a@b.com");
    const dispatch = (action: Parameters<typeof intakeReducer>[1]) => {
      state = intakeReducer(state, action);
    };
    state = intakeReducer(state, {
      type: "filesAdded",
      files: [
        {
          id: "u1",
          file: new File(["x"], "a.pdf"),
          rejection: null,
          selected: true,
          status: "pending",
          progress: 0,
        },
      ],
    });

    const deps = {
      generateUploadUrl: vi.fn().mockResolvedValue("https://up/1"),
    };
    const file = { id: "u1", file: new File(["x"], "a.pdf") };
    const first = uploadIntakeFileToStorage(deps, file, dispatch);
    const second = uploadIntakeFileToStorage(deps, file, dispatch);
    expect(second).toBe(first);
    expect(intakeUploadInFlight("u1")).toBe(first);

    await vi.waitFor(() => {
      expect(state.uploadedFiles[0]?.progress).toBe(30);
    });

    resolveUpload();
    await first;

    expect(state.uploadedFiles[0]).toMatchObject({
      status: "complete",
      progress: 100,
    });
    expect(postBytesToConvexWithProgress).toHaveBeenCalledTimes(1);
  });

  it("surfaces an actionable error and skips the upload when the file can't be read (cloud placeholder)", async () => {
    let state = initialIntakeState("a@b.com");
    const dispatch = (action: Parameters<typeof intakeReducer>[1]) => {
      state = intakeReducer(state, action);
    };
    state = intakeReducer(state, {
      type: "filesAdded",
      files: [
        {
          id: "u1",
          file: new File(["x"], "a.pdf"),
          rejection: null,
          selected: true,
          status: "pending",
          progress: 0,
        },
      ],
    });

    // A dehydrated Dropbox/OneDrive pick: read-retry exhausts and throws the
    // tagged unreadable error. The upload must not even mint a URL or POST.
    const unreadableErr = new Error(UNREADABLE_FILE_MESSAGE);
    unreadableErr.name = "ConvexFileUnreadableError";
    vi.mocked(readFileBytesWithRetry).mockRejectedValue(unreadableErr);
    const generateUploadUrl = vi.fn();

    await expect(
      uploadIntakeFileToStorage(
        { generateUploadUrl },
        { id: "u1", file: new File(["x"], "cloud.pdf") },
        dispatch,
      ),
    ).rejects.toThrow(/Re-add/);

    expect(generateUploadUrl).not.toHaveBeenCalled();
    expect(postBytesToConvexWithProgress).not.toHaveBeenCalled();
    expect(state.uploadedFiles[0]).toMatchObject({ status: "error" });
    expect(state.uploadedFiles[0]?.uploadError).toBe(UNREADABLE_FILE_MESSAGE);
  });

  it("reports the terminal failure to Sentry with size + extension context", async () => {
    vi.mocked(readFileBytesWithRetry).mockResolvedValue(new ArrayBuffer(8));
    vi.mocked(postBytesToConvexWithProgress).mockRejectedValue(
      new Error("Convex storage upload failed (413)"),
    );
    const dispatch = vi.fn();
    const file = new File(["payload"], "quote.pdf");

    await uploadIntakeFileToStorage(
      { generateUploadUrl: vi.fn().mockResolvedValue("https://up/1") },
      { id: "u1", file },
      dispatch,
    ).catch(() => {});

    expect(reportUploadError).toHaveBeenCalledTimes(1);
    const [err, ctx] = vi.mocked(reportUploadError).mock.calls[0];
    expect((err as Error).message).toMatch(/413/);
    expect(ctx).toMatchObject({ bytes: file.size, ext: "pdf", attempts: 3 });
  });

  it("queueIntakeFileUploads skips ids already in flight", async () => {
    let resolveUpload!: () => void;
    const uploadDone = new Promise<{ storageId: string }>((resolve) => {
      resolveUpload = () => resolve({ storageId: "st_1" });
    });
    vi.mocked(postBytesToConvexWithProgress).mockImplementation(
      async () => {
        await uploadDone;
        return { storageId: "st_1" };
      },
    );

    const dispatch = vi.fn();
    const deps = {
      generateUploadUrl: vi.fn().mockResolvedValue("https://up/1"),
    };
    const row = {
      id: "u1",
      file: new File(["x"], "a.pdf"),
      rejection: null as string | null,
    };

    queueIntakeFileUploads(deps, [row], dispatch);
    queueIntakeFileUploads(deps, [row], dispatch);

    await vi.waitFor(() => {
      expect(postBytesToConvexWithProgress).toHaveBeenCalledTimes(1);
    });
    resolveUpload();
    await intakeUploadInFlight("u1");
  });

  it("awaitIntakeUploads resolves even when an in-flight upload rejects", async () => {
    resetIntakeUploadCaches();
    let rejectUpload!: (e: Error) => void;
    vi.mocked(postBytesToConvexWithProgress).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectUpload = reject;
        }),
    );

    const dispatch = vi.fn();
    const deps = { generateUploadUrl: vi.fn().mockResolvedValue("https://up/1") };
    const tracked = uploadIntakeFileToStorage(
      deps,
      { id: "w1", file: new File(["x"], "a.pdf") },
      dispatch,
    );
    // Keep the rejected tracked promise from surfacing as an unhandled rejection.
    const trackedSettled = tracked.catch(() => {});

    await vi.waitFor(() => {
      expect(postBytesToConvexWithProgress).toHaveBeenCalled();
    });

    const waitDone = awaitIntakeUploads(["w1"]);
    // A non-transport error throws immediately (no retry), failing the upload.
    rejectUpload(new Error("Convex storage upload failed (413)"));

    await expect(waitDone).resolves.toBeUndefined();
    await trackedSettled;
    resetIntakeUploadCaches();
  });

  it("queueIntakeFileUploads caps concurrent uploads at UPLOAD_CONCURRENCY", async () => {
    resetIntakeUploadCaches();
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    vi.mocked(postBytesToConvexWithProgress).mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      active -= 1;
      return { storageId: "st" };
    });

    const dispatch = vi.fn();
    const deps = { generateUploadUrl: vi.fn().mockResolvedValue("https://up/1") };
    const rows = Array.from({ length: UPLOAD_CONCURRENCY * 2 }, (_, i) => ({
      id: `c${i}`,
      file: new File(["x"], `f${i}.pdf`),
      rejection: null as string | null,
    }));

    queueIntakeFileUploads(deps, rows, dispatch);

    // Only the first wave reaches the byte POST; the rest wait for a free slot.
    await vi.waitFor(() => {
      expect(postBytesToConvexWithProgress).toHaveBeenCalledTimes(UPLOAD_CONCURRENCY);
    });
    expect(active).toBe(UPLOAD_CONCURRENCY);

    // Drain: flush every released slot, give the real byte-read a macrotask to
    // settle, and repeat until all rows have POSTed. The pool stays full but the
    // cap is never exceeded.
    while (vi.mocked(postBytesToConvexWithProgress).mock.calls.length < rows.length) {
      while (releases.length > 0) releases.shift()?.();
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    while (releases.length > 0) releases.shift()?.();
    await vi.waitFor(() => {
      expect(postBytesToConvexWithProgress).toHaveBeenCalledTimes(rows.length);
    });
    expect(peak).toBe(UPLOAD_CONCURRENCY);
    resetIntakeUploadCaches();
  });
});
