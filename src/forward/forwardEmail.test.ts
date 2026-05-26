/* eslint-disable require-await, max-lines-per-function */
import { describe, it, expect, vi, afterEach } from "vitest";
import { forwardEmail, type ForwardDeps } from "./forwardEmail";
import type { MailItemData } from "../office/useMailItem";
import type { ForwardTargets } from "./targets";

function makeMailItem(attachments: MailItemData["attachments"] = []): MailItemData {
  return {
    subject: "Hello",
    from: "a@x.com",
    to: ["b@x.com"],
    cc: [],
    body: "body text",
    dateTimeCreated: new Date(0),
    internetMessageId: "<id>",
    itemId: "item1",
    conversationId: "conv1",
    userEmail: "me@x.com",
    attachments,
  };
}

function makeTargets(overrides: Partial<ForwardTargets> = {}): ForwardTargets {
  return {
    bot: false,
    chat: true,
    bitable: false,
    attachPdf: false,
    includeAttachments: false,
    createDoc: false,
    contacts: [],
    groups: [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ForwardDeps> = {}): ForwardDeps {
  return {
    getAttachmentContent: vi.fn(async () => ({ format: "base64", content: "" })),
    generateUploadUrl: vi.fn(async () => "https://upload"),
    uploadAttachment: vi.fn(async () => ({ fileKey: "FK" })),
    uploadImage: vi.fn(async () => ({ imageKey: "IK" })),
    createDoc: vi.fn(async () => ({ docUrl: "https://doc", docToken: "DT" })),
    forwardToFeishu: vi.fn(async () => ({})),
    generatePdf: vi.fn(async () => new ArrayBuffer(8)),
    generateMarkdown: vi.fn(async () => "# md"),
    applyFeishuCategory: vi.fn(async () => true),
    onProgress: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("forwardEmail", () => {
  it("forwards with no extras and tags the email when nothing optional is selected", async () => {
    const deps = makeDeps();
    await forwardEmail(deps, makeMailItem(), makeTargets(), "sess");

    expect(vi.mocked(deps.forwardToFeishu)).toHaveBeenCalledTimes(1);
    const args = vi.mocked(deps.forwardToFeishu).mock.calls[0][0];
    expect(args.sessionId).toBe("sess");
    expect(args.targets).toEqual({ bot: false, chat: true, bitable: false });
    expect(args.pdfBytes).toBeUndefined();
    expect(args.pdfStorageId).toBeUndefined();
    expect(args.attachmentFileKeys).toBeUndefined();
    expect(args.feishuDocUrl).toBeUndefined();
    expect(vi.mocked(deps.generatePdf)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.applyFeishuCategory)).toHaveBeenCalledTimes(1);
  });

  it("sends a small PDF inline as bytes (the forward action uploads it)", async () => {
    const deps = makeDeps();
    await forwardEmail(deps, makeMailItem(), makeTargets({ attachPdf: true }), "sess");

    // PDF gen reuses the already-read mail body (no second Office read).
    expect(vi.mocked(deps.generatePdf)).toHaveBeenCalledWith("Hello", "body text");
    // A few-KB text PDF rides to the forward action inline as bytes — no client
    // upload round-trip and no storage staging (ADR-0004).
    const fwd = vi.mocked(deps.forwardToFeishu).mock.calls[0][0];
    expect(fwd.pdfBytes).toBeInstanceOf(ArrayBuffer);
    expect(fwd.pdfStorageId).toBeUndefined();
  });

  it("stages a large PDF via storage to stay under the arg cap", async () => {
    globalThis.fetch = vi.fn(async () => ({ json: async () => ({ storageId: "S1" }) }) as Response) as unknown as typeof fetch;
    const deps = makeDeps({ generatePdf: vi.fn(async () => new ArrayBuffer(5 * 1024 * 1024)) });
    await forwardEmail(deps, makeMailItem(), makeTargets({ attachPdf: true }), "sess");

    const fwd = vi.mocked(deps.forwardToFeishu).mock.calls[0][0];
    expect(fwd.pdfStorageId).toBe("S1");
    expect(fwd.pdfBytes).toBeUndefined();
  });

  it("creates a Feishu doc and threads its url into the forward when createDoc is set", async () => {
    const deps = makeDeps();
    await forwardEmail(deps, makeMailItem(), makeTargets({ createDoc: true }), "sess");

    expect(vi.mocked(deps.generateMarkdown)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.createDoc)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.forwardToFeishu).mock.calls[0][0].feishuDocUrl).toBe("https://doc");
  });

  it("threads Act II request content and coworker labels into the forward payload", async () => {
    const deps = makeDeps();
    await forwardEmail(
      deps,
      makeMailItem(),
      makeTargets({
        contacts: ["ou_jenny"],
        requestSelections: [{ requestType: "Quotation", note: "Need L-Carnitine pricing." }],
        selectedCoworkers: [{ openId: "ou_jenny", name: "Jenny Xu" }],
      }),
      "sess",
    );

    const fwd = vi.mocked(deps.forwardToFeishu).mock.calls[0][0];
    expect(fwd.contacts).toEqual(["ou_jenny"]);
    expect(fwd.requestSelections).toEqual([
      { requestType: "Quotation", note: "Need L-Carnitine pricing." },
    ]);
    expect(fwd.selectedCoworkers).toEqual([{ openId: "ou_jenny", name: "Jenny Xu" }]);
  });

  it("uploads attachments through storage and routes images to uploadImage", async () => {
    globalThis.fetch = vi.fn(async () => ({ json: async () => ({ storageId: "S1" }) }) as Response) as unknown as typeof fetch;
    const deps = makeDeps();
    const mailItem = makeMailItem([
      { id: "a1", name: "pic.png", contentType: "image/png", size: 100, isInline: false },
    ]);

    await forwardEmail(deps, mailItem, makeTargets({ includeAttachments: true }), "sess");

    expect(vi.mocked(deps.uploadImage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.uploadAttachment)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.forwardToFeishu).mock.calls[0][0].attachmentFileKeys).toEqual([
      { fileKey: "IK", fileName: "pic.png", type: "image" },
    ]);
  });

  it("reports the forward outcome (requested vs delivered)", async () => {
    globalThis.fetch = vi.fn(async () => ({ json: async () => ({ storageId: "S1" }) }) as Response) as unknown as typeof fetch;
    const onOutcome = vi.fn();
    const deps = makeDeps({ onOutcome });
    const mailItem = makeMailItem([
      { id: "a1", name: "f.bin", contentType: "application/octet-stream", size: 100, isInline: false },
    ]);

    await forwardEmail(deps, mailItem, makeTargets({ attachPdf: true, includeAttachments: true }), "sess");

    expect(onOutcome).toHaveBeenCalledTimes(1);
    const outcome = vi.mocked(onOutcome).mock.calls[0][0];
    expect(outcome.pdf).toEqual({ requested: true, delivered: true });
    expect(outcome.attachments).toEqual({ requested: 1, delivered: 1, oversize: 0 });
    expect(outcome.doc).toEqual({ requested: false, delivered: false });
  });
});
