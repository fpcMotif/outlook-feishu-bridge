import { describe, expect, it } from "vitest";

import {
  collectFailedUploadIds,
  countFailedUploads,
  humanizeUploadError,
} from "./uploadError";
import type { UploadedFile } from "./intakeReducer";

const upload = (over: Partial<UploadedFile> & { id: string }): UploadedFile => ({
  file: new File(["x"], `${over.id}.png`),
  rejection: null,
  selected: true,
  ...over,
});

describe("humanizeUploadError", () => {
  it("maps a network failure to a connection-focused line", () => {
    expect(humanizeUploadError("Convex storage upload failed (network)")).toBe(
      "Couldn't upload — check your connection, then Retry",
    );
  });

  it("maps a timeout to a timeout line", () => {
    expect(humanizeUploadError("Convex storage upload timed out")).toBe(
      "Upload timed out — tap Retry",
    );
  });

  it("maps an HTTP 4xx/5xx to a rejected line", () => {
    expect(humanizeUploadError("Convex storage upload failed (413)")).toBe(
      "Upload was rejected — tap Retry",
    );
    expect(humanizeUploadError("Convex storage upload failed (500)")).toBe(
      "Upload was rejected — tap Retry",
    );
  });

  it("passes the cloud-placeholder read error through verbatim (already actionable)", () => {
    const raw =
      "Couldn't read this file. If it lives in Dropbox or OneDrive, wait for it " +
      "to finish downloading to this PC, then remove it and add it again.";
    expect(humanizeUploadError(raw)).toBe(raw);
  });

  it("falls back to the friendly default for null/unknown", () => {
    expect(humanizeUploadError(null)).toBe("Couldn't upload — tap Retry");
    expect(humanizeUploadError(undefined)).toBe("Couldn't upload — tap Retry");
    expect(humanizeUploadError("kaboom")).toBe("Couldn't upload — tap Retry");
  });
});

describe("collectFailedUploadIds / countFailedUploads", () => {
  const files: UploadedFile[] = [
    upload({ id: "ok", status: "complete" }),
    upload({ id: "err1", status: "error" }),
    upload({ id: "up", status: "uploading" }),
    upload({ id: "err2", status: "error" }),
    upload({ id: "rej", status: "error", rejection: "unsupported type" }),
  ];

  it("returns ids of valid failed uploads in order", () => {
    expect(collectFailedUploadIds(files)).toEqual(["err1", "err2"]);
  });

  it("counts only valid failed uploads (rejected ones excluded)", () => {
    expect(countFailedUploads(files)).toBe(2);
  });
});
