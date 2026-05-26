const CATEGORY_NAME = "Sent to Feishu";

// Office.MailboxEnums only exists inside Outlook; read the color lazily here,
// not at module load, or the SPA crashes on boot in a plain browser.
function ensureMasterCategory(): Promise<void> {
  return new Promise((resolve) => {
    const masterCategories = Office.context.mailbox.masterCategories;
    masterCategories.addAsync(
      [{ displayName: CATEGORY_NAME, color: Office.MailboxEnums.CategoryColor.Preset9 }],
      () => {
        // Resolve even on DuplicateCategory error - category already exists
        resolve();
      },
    );
  });
}

export async function applyFeishuCategory(): Promise<boolean> {
  try {
    const item = Office.context?.mailbox?.item;
    if (!item?.categories) return false;

    await ensureMasterCategory();

    return new Promise((resolve) => {
      item.categories.addAsync([CATEGORY_NAME], (result) => {
        resolve(result.status === Office.AsyncResultStatus.Succeeded);
      });
    });
  } catch {
    return false;
  }
}
