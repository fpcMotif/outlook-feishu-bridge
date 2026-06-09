import { describe, expect, it } from "vitest";

import {
  DEFAULT_ATTACHMENT_CAP,
  assertWithinAttachmentCap,
} from "./attachmentLimits";

describe("assertWithinAttachmentCap", () => {
  it("defaults the cap to 10", () => {
    expect(DEFAULT_ATTACHMENT_CAP).toBe(10);
  });

  it("allows a batch at or below the cap", () => {
    const five = Array.from({ length: 5 }, (_, i) => i);
    expect(() =>
      assertWithinAttachmentCap({ attachmentSources: five }, 10),
    ).not.toThrow();
    expect(() =>
      assertWithinAttachmentCap(
        { attachmentSources: Array.from({ length: 10 }) },
        10,
      ),
    ).not.toThrow();
  });

  it("rejects a batch above the cap with the count and cap in the message", () => {
    expect(() =>
      assertWithinAttachmentCap(
        { attachmentSources: Array.from({ length: 11 }) },
        10,
      ),
    ).toThrow(/11 exceeds the 10-file cap/);
  });

  it("counts staged sources AND legacy tokens together", () => {
    expect(() =>
      assertWithinAttachmentCap(
        {
          attachmentSources: Array.from({ length: 6 }),
          attachments: Array.from({ length: 5 }),
        },
        10,
      ),
    ).toThrow(/11 exceeds the 10-file cap/);
  });

  it("treats missing arrays as zero", () => {
    expect(() => assertWithinAttachmentCap({}, 10)).not.toThrow();
  });

  it("honors a lifted experiment cap (e.g. 50)", () => {
    expect(() =>
      assertWithinAttachmentCap(
        { attachmentSources: Array.from({ length: 50 }) },
        50,
      ),
    ).not.toThrow();
    expect(() =>
      assertWithinAttachmentCap(
        { attachmentSources: Array.from({ length: 51 }) },
        50,
      ),
    ).toThrow(/51 exceeds the 50-file cap/);
  });
});
