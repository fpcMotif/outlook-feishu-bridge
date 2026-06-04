// Dev/preview coworker open_ids used by the browser taskpane and e2e harness.
// They are NOT valid Feishu Person ids and must never reach Bitable create.
// Keep in sync with src/testing/preview-coworkers.ts and TaskPane dev user ids.
const PREVIEW_COWORKER_OPEN_IDS = new Set([
  "ou_jenny",
  "ou_michael",
  "ou_sales_ops",
  "ou_wei",
  "ou_maria",
  "ou_carlos",
  "ou_aiko",
  "ou_lena",
  "ou_dev",
]);

export function isPreviewCoworkerOpenId(openId: string | undefined | null): boolean {
  if (!openId) return false;
  if (PREVIEW_COWORKER_OPEN_IDS.has(openId)) return true;
  return openId.startsWith("ou_dev_fixture_");
}

export function assertRealCoworkerOpenIds(coworkers: { openId: string; name?: string }[]): void {
  for (const coworker of coworkers) {
    if (isPreviewCoworkerOpenId(coworker.openId)) {
      throw new Error(
        `Coworker "${coworker.name ?? coworker.openId}" uses a dev preview id (${coworker.openId}); ` +
          "pick a real Feishu colleague before syncing to Base.",
      );
    }
  }
}

// Browser dev sync UI sample: src/testing/sync-preview-fixtures.ts (DEV_SYNC_PREVIEW).
// Browser dev sample mail (TaskPane DEV_SAMPLE). Must never enter the live outbox.
export const DEV_SAMPLE_CONVERSATION_ID = "dev-sample";
export const DEV_SAMPLE_INTERNET_MESSAGE_ID = "<dev-sample@fenchem.com>";

export function isDevSampleConversationId(conversationId: string | undefined | null): boolean {
  return conversationId?.trim() === DEV_SAMPLE_CONVERSATION_ID;
}

export function isDevSampleInternetMessageId(internetMessageId: string | undefined | null): boolean {
  return internetMessageId?.trim() === DEV_SAMPLE_INTERNET_MESSAGE_ID;
}

export function hasPreviewCoworkerSelection(
  coworkers: { openId: string }[] | undefined,
): boolean {
  return coworkers?.some((coworker) => isPreviewCoworkerOpenId(coworker.openId)) ?? false;
}

export interface PoisonedOutboxLookup {
  internetMessageId?: string;
  conversationId?: string;
  selectedCoworkers?: { openId: string }[];
}

/** Non-retryable outbox rows: dev fixtures or browser sample mail. */
export function poisonedOutboxReason(lookup: PoisonedOutboxLookup): string | null {
  if (hasPreviewCoworkerSelection(lookup.selectedCoworkers)) {
    return "Abandoned: dev preview coworker ids cannot sync to Feishu Base.";
  }
  if (
    isDevSampleConversationId(lookup.conversationId) ||
    isDevSampleInternetMessageId(lookup.internetMessageId)
  ) {
    return "Abandoned: browser dev-sample mail must not sync to Feishu Base.";
  }
  return null;
}

export function isPoisonedOutboxRecord(lookup: PoisonedOutboxLookup): boolean {
  return poisonedOutboxReason(lookup) !== null;
}
