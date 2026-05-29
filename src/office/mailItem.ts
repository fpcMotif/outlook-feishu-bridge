// Pure Office.js → MailItemData mappers, extracted from the useMailItem hook
// (ADR-0018) so they are unit-testable by passing a stub Office handle instead
// of reaching for the global — the same dependency-injection seam selfForwardChain
// uses for fetch, and the stub-Office pattern mailBody.test.ts already follows.
//
// The EWS→REST id conversion is load-bearing: the id it produces is what Microsoft
// Graph's `messages/{id}/forward` consumes for the Self-Forward (ADR-0017), so it
// earns direct coverage rather than living untested inside a React hook.
//
// Office.js APIs are cited against learn.microsoft.com / github.com/OfficeDev only:
//   convertToRestId — https://learn.microsoft.com/javascript/api/outlook/office.mailbox#convertToRestId
//   item.from/to/cc (EmailAddressDetails) — https://learn.microsoft.com/javascript/api/outlook/office.messageread

export interface MailItemData {
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  /** Plain-text body via `body.getAsync(CoercionType.Text)`. */
  body: string;
  dateTimeCreated: Date | null;
  internetMessageId: string;
  /** REST/Graph id converted from the Office.js EWS item id. */
  itemId: string;
  conversationId: string;
  userEmail: string;
}

export type ReadItem = Office.MessageRead & Office.ItemRead;

/** The slice of the Office namespace the mappers need, injected for testability. */
export type OfficeLike = typeof Office;

// In compose/reply windows item.subject/to/cc are async objects (Subject,
// Recipients) exposing getAsync, not the string/array shapes read mode gives.
// This add-in syncs received mail only, so callers fail clearly instead of crashing.
export function isComposeItem(item: unknown): boolean {
  const subject = (item as { subject?: unknown } | undefined)?.subject;
  return (
    typeof subject === "object" &&
    subject !== null &&
    typeof (subject as { getAsync?: unknown }).getAsync === "function"
  );
}

export function emailList(
  value: readonly Office.EmailAddressDetails[] | undefined,
): string[] {
  return Array.isArray(value) ? value.map((r) => r.emailAddress) : [];
}

// Convert the Office.js EWS item id to the REST/Graph v2.0 id. Falls back to the
// raw id when conversion is unavailable (e.g. Outlook mobile, where the id is
// already REST-formatted and the API is unsupported).
export function convertToRestId(office: OfficeLike, ewsId: string | undefined): string {
  if (!ewsId) return "";
  try {
    return office.context.mailbox.convertToRestId(
      ewsId,
      office.MailboxEnums.RestVersion.v2_0,
    );
  } catch {
    return ewsId;
  }
}

export function extractMailData(
  office: OfficeLike,
  item: ReadItem,
  body: string,
): MailItemData {
  return {
    subject: item.subject ?? "",
    from: item.from?.emailAddress ?? "",
    to: emailList(item.to),
    cc: emailList(item.cc),
    body,
    dateTimeCreated: item.dateTimeCreated ?? null,
    internetMessageId: item.internetMessageId ?? "",
    itemId: convertToRestId(office, item.itemId),
    conversationId: item.conversationId ?? "",
    userEmail: office.context?.mailbox?.userProfile?.emailAddress ?? "",
  };
}
