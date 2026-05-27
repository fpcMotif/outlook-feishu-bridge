import type { CSSProperties } from "react";
import { FileText, FlaskConical, PackageCheck, type LucideIcon } from "lucide-react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Textarea } from "@/components/ui/textarea";

export interface RequestDef {
  id: string;
  title: string;
  icon: LucideIcon;
  description: string;
  placeholder: string;
}

export const REQUESTS: RequestDef[] = [
  {
    id: "quotation",
    title: "Quotation",
    icon: FileText,
    description: "Price, quantity, delivery",
    placeholder: "Add the quotation details...",
  },
  {
    id: "sample",
    title: "Sample",
    icon: PackageCheck,
    description: "Sample size and shipping",
    placeholder: "Add the sample request...",
  },
  {
    id: "rd",
    title: "R&D Support",
    icon: FlaskConical,
    description: "Specs and technical questions",
    placeholder: "Add the R&D question...",
  },
];

const ITEM_CLASS =
  "request-card-enter bg-card rounded-[16px] border shadow-sm transition-[border-color,box-shadow,transform] duration-300 ease-out hover:-translate-y-0.5 hover:shadow-md data-[state=open]:shadow-lg";

function RequestCard({
  request,
  index,
  value,
  onChange,
}: {
  request: RequestDef;
  index: number;
  value: string;
  onChange: (id: string, value: string) => void;
}) {
  return (
    <AccordionItem
      value={request.id}
      className={ITEM_CLASS}
      style={{ "--card-index": index } as CSSProperties}
    >
      <RequestTrigger request={request} />
      <AccordionContent className="px-4 pb-4">
        <Textarea
          value={value}
          onChange={(e) => onChange(request.id, e.target.value)}
          placeholder={request.placeholder}
          rows={4}
        />
      </AccordionContent>
    </AccordionItem>
  );
}

function RequestTrigger({ request }: { request: RequestDef }) {
  const Icon = request.icon;
  return (
    <AccordionTrigger className="px-4 py-4">
      <span className="flex min-w-0 items-center gap-3">
        <span className="bg-card-soft text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-xl">
          <Icon className="size-5" />
        </span>
        <span className="min-w-0">
          <span className="font-serif block text-[23px] leading-none">{request.title}</span>
          <span className="text-muted-foreground mt-1 block truncate text-xs">
            {request.description}
          </span>
        </span>
      </span>
    </AccordionTrigger>
  );
}

export function RequestCards({
  values,
  onChange,
}: {
  values: Record<string, string>;
  onChange: (id: string, value: string) => void;
}) {
  return (
    <Accordion type="single" collapsible className="space-y-3">
      {REQUESTS.map((request, index) => (
        <RequestCard
          key={request.id}
          request={request}
          index={index}
          value={values[request.id] ?? ""}
          onChange={onChange}
        />
      ))}
    </Accordion>
  );
}
