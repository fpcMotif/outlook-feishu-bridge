// Deep module: read the current Outlook mail item's body. Wraps Office.js's
// callback-style item.body.getAsync into a promise and owns the "no item
// selected" and async-failure cases, so callers (mail read, PDF render,
// markdown conversion) don't each re-implement the getAsync dance.

function currentItem(): Office.MessageRead {
  const item = Office.context?.mailbox?.item as Office.MessageRead | undefined;
  if (!item) throw new Error("No mail item selected");
  return item;
}

export function readMailBody(coercion: Office.CoercionType): Promise<string> {
  const item = currentItem();
  return new Promise<string>((resolve, reject) => {
    item.body.getAsync(coercion, (result: Office.AsyncResult<string>) => {
      if (result.status === Office.AsyncResultStatus.Succeeded) {
        resolve(result.value);
      } else {
        reject(new Error(result.error.message));
      }
    });
  });
}

export const readMailBodyText = (): Promise<string> =>
  readMailBody(Office.CoercionType.Text);

export const readMailBodyHtml = (): Promise<string> =>
  readMailBody(Office.CoercionType.Html);
