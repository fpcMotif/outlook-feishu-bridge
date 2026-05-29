// applyFeishuCategory tags the current Outlook message with a "Sent to Feishu"
// master category after a successful Bitable sync. The Office category APIs
// (masterCategories.addAsync / item.categories.addAsync) only exist inside
// Outlook, so we stub globalThis.Office per the mailBody.test.ts pattern and
// drive each callback to cover the success, no-categories, status-Failed,
// DuplicateCategory-tolerant, and synchronous-throw branches.
//
// Office category APIs cited against learn.microsoft.com only:
//   masterCategories.addAsync — https://learn.microsoft.com/javascript/api/outlook/office.mastercategories
//   item.categories.addAsync — https://learn.microsoft.com/javascript/api/outlook/office.categories
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyFeishuCategory } from "./mailCategory";

type AddAsyncCb = (result: { status: string }) => void;

interface OfficeStub {
  masterAdd: ReturnType<typeof vi.fn>;
  itemAdd?: ReturnType<typeof vi.fn>;
}

// Install a stub Office with controllable master/item addAsync. masterStatus
// drives the master category callback; itemStatus drives the per-item add. When
// `noItem`/`noCategories` is set, the guard short-circuits before any add.
function installOffice(opts: {
  noItem?: boolean;
  noCategories?: boolean;
  masterStatus?: string;
  itemStatus?: string;
  contextThrows?: boolean;
}): OfficeStub {
  const masterAdd = vi.fn((_cats: unknown[], cb: AddAsyncCb) =>
    cb({ status: opts.masterStatus ?? "succeeded" }),
  );
  const itemAdd = vi.fn((_cats: string[], cb: AddAsyncCb) =>
    cb({ status: opts.itemStatus ?? "succeeded" }),
  );

  const mailbox = {
    item: opts.noItem
      ? undefined
      : { categories: opts.noCategories ? undefined : { addAsync: itemAdd } },
    masterCategories: { addAsync: masterAdd },
  };

  const context = opts.contextThrows
    ? // A context whose property access throws synchronously, exercising the
      // try/catch that swallows any Office failure into a false return.
      new Proxy(
        {},
        {
          get() {
            throw new Error("Office boom");
          },
        },
      )
    : { mailbox };

  (globalThis as unknown as { Office: unknown }).Office = {
    context,
    AsyncResultStatus: { Succeeded: "succeeded", Failed: "failed" },
    MailboxEnums: { CategoryColor: { Preset9: "Preset9" } },
  };

  return { masterAdd, itemAdd: opts.noItem || opts.noCategories ? undefined : itemAdd };
}

afterEach(() => {
  delete (globalThis as unknown as { Office?: unknown }).Office;
  vi.restoreAllMocks();
});

describe("applyFeishuCategory", () => {
  it("returns false without touching masterCategories when there is no mail item", async () => {
    const { masterAdd } = installOffice({ noItem: true });
    await expect(applyFeishuCategory()).resolves.toBe(false);
    expect(masterAdd).not.toHaveBeenCalled();
  });

  it("returns false when the item exists but item.categories is undefined", async () => {
    const { masterAdd } = installOffice({ noCategories: true });
    await expect(applyFeishuCategory()).resolves.toBe(false);
    expect(masterAdd).not.toHaveBeenCalled();
  });

  it("ensures the 'Sent to Feishu' master category (Preset9) before adding it to the item", async () => {
    const { masterAdd, itemAdd } = installOffice({});

    await expect(applyFeishuCategory()).resolves.toBe(true);

    // The master category is created with the documented name + colour first.
    expect(masterAdd).toHaveBeenCalledTimes(1);
    expect(masterAdd.mock.calls[0][0]).toEqual([
      { displayName: "Sent to Feishu", color: "Preset9" },
    ]);
    // Then the category is applied to the current item by name.
    expect(itemAdd).toHaveBeenCalledTimes(1);
    expect(itemAdd?.mock.calls[0][0]).toEqual(["Sent to Feishu"]);
    // Ordering: ensureMasterCategory must resolve before the per-item add runs.
    expect(masterAdd.mock.invocationCallOrder[0]).toBeLessThan(
      itemAdd!.mock.invocationCallOrder[0],
    );
  });

  it("resolves true when item.categories.addAsync reports Succeeded", async () => {
    installOffice({ itemStatus: "succeeded" });
    await expect(applyFeishuCategory()).resolves.toBe(true);
  });

  it("resolves false when item.categories.addAsync reports Failed", async () => {
    installOffice({ itemStatus: "failed" });
    await expect(applyFeishuCategory()).resolves.toBe(false);
  });

  it("still resolves (does not hang) when the master add callback fires on a DuplicateCategory-style error", async () => {
    // ensureMasterCategory resolves on ANY callback, even a duplicate-category
    // error, so a pre-existing category does not block the per-item add.
    installOffice({ masterStatus: "failed", itemStatus: "succeeded" });
    await expect(applyFeishuCategory()).resolves.toBe(true);
  });

  it("returns false when Office.context access throws synchronously", async () => {
    const { masterAdd } = installOffice({ contextThrows: true });
    await expect(applyFeishuCategory()).resolves.toBe(false);
    expect(masterAdd).not.toHaveBeenCalled();
  });
});
