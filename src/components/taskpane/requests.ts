export interface RequestDef {
  id: string;
  title: string;
  placeholder: string;
}

export const REQUESTS: RequestDef[] = [
  {
    id: "quotation",
    title: "Quotation",
    placeholder: "Describe your requirements: product, quantity, target price, delivery window.",
  },
  {
    id: "sample",
    title: "Sample",
    placeholder: "Need 50 g of SX-440 silica blend, ship to Acme R&D in Eindhoven.",
  },
  {
    id: "rd",
    title: "R&D Support",
    placeholder: "Describe the challenge, target spec, and constraints.",
  },
];
