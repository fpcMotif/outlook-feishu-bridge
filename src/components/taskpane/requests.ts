export interface RequestDef {
  id: string;
  title: string;
  dot: string;
  placeholder: string;
}

export const REQUESTS: RequestDef[] = [
  {
    id: "quotation",
    title: "Quotation",
    dot: "var(--primary)",
    placeholder: "Describe your requirements: product, quantity, target price, delivery window.",
  },
  {
    id: "sample",
    title: "Sample",
    dot: "var(--sage)",
    placeholder: "Need 50 g of SX-440 silica blend, ship to Acme R&D in Eindhoven.",
  },
  {
    id: "rd",
    title: "R&D Support",
    dot: "oklch(0.544 0.138 297.522)",
    placeholder: "Describe the challenge, target spec, and constraints.",
  },
];
