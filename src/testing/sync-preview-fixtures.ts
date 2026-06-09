import type { SyncPreviewPayload } from "../components/taskpane/syncPreviewModel";

/** Browser dev sync screen (`?devScreen=sync`) — rich notes + attachments. */
export const DEV_SYNC_PREVIEW: SyncPreviewPayload = {
  customerLabel: "Bayer Pharma AG",
  notes: [
    {
      id: "sample",
      label: "Sample",
      text: "50 g SX-440 silica blend for Hamburg formulation trials.",
    },
    {
      id: "quotation",
      label: "Quotation",
      text: "L-Carnitine USP quote ~2,500 kg/yr with COA and Hamburg lead times.",
    },
    {
      id: "rd",
      label: "R&D Support",
      text: "Stability data for SX-440 aqueous dispersions above 40 °C.",
    },
  ],
  attachments: [
    { name: "RFQ-2026-Q1.pdf" },
    { name: "SX-440-spec-sheet.xlsx" },
    { name: "COA-reference.pdf" },
  ],
};
