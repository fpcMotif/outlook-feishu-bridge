import { beforeEach, describe, expect, it, vi } from "vitest";

import { initialIntakeState, intakeReducer } from "./intakeReducer";
import {
  awaitIntakeUploads,
  intakeUploadInFlight,
  queueIntakeFileUploads,
  resetIntakeUploadCaches,
  uploadIntakeFileToStorage,
} from "./uploadIntakeFile";

vi.mock("../../office/attachmentUpload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../office/attachmentUpload")>();
  return {
    ...actual,
    postBytesToConvexWithProgress: vi.fn(),
  };
});

import { postBytesToConvexWithProgress } from "../../office/attachmentUpload";

describe("uploadIntakeFileToStorage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetIntakeUploadCaches();
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

  it("runs at most the configured number of uploads concurrently", async () => {
    // Each upload parks until released, so `inFlightNow` is exactly the number
    // of POSTs the pool has running at once; `maxInFlight` is the high-water
    // mark across the whole drain.
    let inFlightNow = 0;
    let maxInFlight = 0;
    let started = 0;
    const releases: Array<() => void> = [];
    vi.mocked(postBytesToConvexWithProgress).mockImplementation(async () => {
      started += 1;
      inFlightNow += 1;
      maxInFlight = Math.max(maxInFlight, inFlightNow);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      inFlightNow -= 1;
      return { storageId: `st_${started}` };
    });

    const dispatch = vi.fn();
    const deps = { generateUploadUrl: vi.fn().mockResolvedValue("https://up/1") };
    const cap = 3;
    const fileCount = 9;
    const rows = Array.from({ length: fileCount }, (_, i) => ({
      id: `cap_${i}`,
      file: new File(["x"], `cap_${i}.pdf`),
      rejection: null as string | null,
    }));

    queueIntakeFileUploads(deps, rows, dispatch, cap);

    // The pool ramps to exactly the cap and parks there — the remaining rows
    // wait for a slot instead of all firing at once.
    await vi.waitFor(() => {
      expect(inFlightNow).toBe(cap);
    });
    expect(started).toBe(cap);

    // Drain every upload one at a time. Freeing a slot pulls in exactly one more,
    // so the in-flight count must never climb above the cap at any point.
    for (let released = 0; released < fileCount; released += 1) {
      await vi.waitFor(() => {
        expect(releases.length).toBeGreaterThan(0);
      });
      expect(inFlightNow).toBeLessThanOrEqual(cap);
      releases.shift()!();
    }

    await awaitIntakeUploads(rows.map((r) => r.id));
    expect(started).toBe(fileCount);
    expect(maxInFlight).toBe(cap);
    expect(maxInFlight).toBeLessThanOrEqual(cap);
  });
});
