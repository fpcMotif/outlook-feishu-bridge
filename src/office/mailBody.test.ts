import { describe, it, expect, afterEach, vi } from "vitest";
import { readMailBodyText } from "./mailBody";

type GetAsyncCb = (r: { status: string; value?: string; error?: { message: string } }) => void;

function installOffice(
  getAsync: (coercion: string, cb: GetAsyncCb) => void,
  hasItem = true,
) {
  (globalThis as unknown as { Office: unknown }).Office = {
    CoercionType: { Text: "text", Html: "html" },
    AsyncResultStatus: { Succeeded: "succeeded", Failed: "failed" },
    context: {
      mailbox: { item: hasItem ? { body: { getAsync } } : undefined },
    },
  };
}

afterEach(() => {
  delete (globalThis as unknown as { Office?: unknown }).Office;
  vi.restoreAllMocks();
});

describe("readMailBody", () => {
  it("resolves the body and passes the requested coercion through", async () => {
    installOffice((coercion, cb) => cb({ status: "succeeded", value: `<${coercion}>` }));
    await expect(readMailBodyText()).resolves.toBe("<text>");
  });

  it("rejects with the Office error message on failure", async () => {
    installOffice((_coercion, cb) => cb({ status: "failed", error: { message: "boom" } }));
    await expect(readMailBodyText()).rejects.toThrow("boom");
  });

  it("throws when no mail item is selected", () => {
    installOffice(() => {}, false);
    expect(() => readMailBodyText()).toThrow("No mail item selected");
  });
});
