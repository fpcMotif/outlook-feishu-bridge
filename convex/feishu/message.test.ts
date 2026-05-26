/* eslint-disable require-await, max-lines-per-function */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./call", () => ({
  callFeishu: vi.fn(async () => ({ message_id: "m1" })),
  resolveFeishuToken: vi.fn(async () => "TOKEN"),
}));

import { callFeishu } from "./call";
import { sendEmailMessage } from "./message";

const mockCall = vi.mocked(callFeishu);
const ctx = {} as unknown as Parameters<typeof sendEmailMessage>[0];
const jsonOf = (i: number) => mockCall.mock.calls[i][1].json as { msg_type: string };

describe("sendEmailMessage", () => {
  beforeEach(() => mockCall.mockClear());

  it("sends only the interactive card when there is no pdf or attachments", async () => {
    const res = await sendEmailMessage(ctx, {
      receiveId: "c1",
      receiveIdType: "chat_id",
      auth: "tenant",
      subject: "S",
      from: "F",
      bodyPreview: "B",
    });
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(jsonOf(0).msg_type).toBe("interactive");
    expect(res.messageId).toBe("m1");
  });

  it("sends card, then pdf, then each attachment in order", async () => {
    await sendEmailMessage(ctx, {
      receiveId: "u1",
      receiveIdType: "open_id",
      auth: "user",
      sessionId: "s",
      subject: "S",
      from: "F",
      bodyPreview: "B",
      pdfFileKey: "pdf1",
      attachmentFileKeys: [
        { fileKey: "img1", fileName: "a.png", type: "image" },
        { fileKey: "file1", fileName: "b.zip", type: "file" },
      ],
    });
    expect(mockCall).toHaveBeenCalledTimes(4);
    expect([0, 1, 2, 3].map((i) => jsonOf(i).msg_type)).toEqual([
      "interactive",
      "file",
      "image",
      "file",
    ]);
  });

  it("forwards the user token kind, sessionId and receive_id_type to the transport", async () => {
    await sendEmailMessage(ctx, {
      receiveId: "u1",
      receiveIdType: "open_id",
      auth: "user",
      sessionId: "s",
      subject: "S",
      from: "F",
      bodyPreview: "B",
    });
    const opts = mockCall.mock.calls[0][1];
    expect(opts.auth).toBe("user");
    expect(opts.sessionId).toBe("s");
    expect(opts.query).toEqual({ receive_id_type: "open_id" });
  });

  it("awaits the card before dispatching any follow-up (card lands first)", async () => {
    // Gate the first call (the card) so it stays pending; follow-ups must not
    // fire until it resolves, even though they now run concurrently.
    let releaseCard!: (v: { message_id: string }) => void;
    mockCall.mockImplementationOnce(
      () => new Promise((r) => { releaseCard = r; }),
    );
    const done = sendEmailMessage(ctx, {
      receiveId: "c1",
      receiveIdType: "chat_id",
      auth: "tenant",
      subject: "S",
      from: "F",
      bodyPreview: "B",
      pdfFileKey: "pdf1",
      attachmentFileKeys: [{ fileKey: "img1", fileName: "a.png", type: "image" }],
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // only the card while it's pending
    expect(mockCall).toHaveBeenCalledTimes(1);
    releaseCard({ message_id: "m1" });
    await done;
    // card + pdf + image
    expect(mockCall).toHaveBeenCalledTimes(3);
  });
});
