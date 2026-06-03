// Pure mapping from the intake state to the syncRequest action args (minus
// attachments, which RequestIntakeScreen folds in after staging). Extracted from
// the component so the payload shape is testable and the submit handler stays
// readable. Field semantics: ADR-0010 (derivable-only) + ADR-0014 (Sales
// initiator / Email Subject) + ADR-0017 (conversationId) + ADR-0022 (requestNote
// + body to Base).

import type { MailItemData } from "../../office/useMailItem";
import type { IntakeState } from "./intakeReducer";

export function buildSyncPayload(
  mailItem: MailItemData,
  state: IntakeState,
  user: { openId: string; userName?: string } | undefined,
  requestNote: string,
) {
  return {
    subject: mailItem.subject,
    from: mailItem.from,
    to: mailItem.to,
    cc: mailItem.cc,
    body: mailItem.body,
    internetMessageId: mailItem.internetMessageId,
    itemId: mailItem.itemId || undefined,
    conversationId: mailItem.conversationId || undefined,
    userEmail: mailItem.userEmail || undefined,
    dateTimeCreated: mailItem.dateTimeCreated?.getTime(),
    clientEmail: state.clientEmail,
    selectedCustomer: state.selectedCustomer
      ? { recordId: state.selectedCustomer.recordId, name: state.selectedCustomer.name }
      : undefined,
    selectedSales: state.selectedSales
      ? { openId: state.selectedSales.openId, name: state.selectedSales.name }
      : user?.openId
        ? { openId: user.openId, name: user.userName }
        : undefined,
    initiator: state.selectedSales
      ? { openId: state.selectedSales.openId, name: state.selectedSales.name }
      : user?.openId
        ? { openId: user.openId, name: user.userName }
        : undefined,
    requestNote,
    selectedCoworkers: state.selectedCoworker ? [state.selectedCoworker] : [],
  };
}
