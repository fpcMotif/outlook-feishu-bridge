import { type MailItemData } from "../../office/useMailItem";

// Browser dev has no Office host or mailbox (useOffice falls back to host
// "browser" after 3s). A sample item lets the full drawer flow render for
// preview; tests mock the Bitable Sync so nothing is actually written.
export const DEV_SAMPLE: MailItemData = {
  subject: "Inquiry - bulk pricing for L-Carnitine 500kg quarterly",
  from: "m.hoffmann@bayerpharma.de",
  to: ["jenny.xu@fenchem.com"],
  cc: ["procurement@bayerpharma.de"],
  body: "Hi Jenny, we are preparing the 2026 procurement plan and would like quarterly bulk pricing for L-Carnitine USP, >=99%. Volume ~2,500 kg/year (Q1-Q4 2026). Please also share COA and lead times to Hamburg port. We'd like to lock a contract by end of next week.",
  dateTimeCreated: new Date(),
  internetMessageId: "<dev-sample@fenchem.com>",
  itemId: "dev-sample",
  conversationId: "dev-sample",
  userEmail: "jenny.xu@fenchem.com",
  attachments: [
    { id: "a1", name: "RFQ-2026-Q1.pdf", contentType: "application/pdf", size: 184320, isInline: false },
  ],
};
