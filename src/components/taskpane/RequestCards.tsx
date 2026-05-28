import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";

import { REQUESTS } from "./requests";

const ITEM_CLASS =
  "group bg-card rounded-[20px] shadow-[var(--shadow-border)] transition-[background-color,box-shadow,scale] duration-200 ease-[var(--ease-out-strong)] data-[state=open]:bg-card data-[state=open]:shadow-[var(--shadow-floating)]";

export function RequestCards({
  values,
  onChange,
}: {
  values: Record<string, string>;
  onChange: (id: string, value: string) => void;
}) {
  return (
    <Accordion type="single" collapsible className="space-y-3">
      {REQUESTS.map((r) => {
        const value = values[r.id] ?? "";
        const filled = value.trim() !== "";
        return (
          <AccordionItem key={r.id} value={r.id} className={ITEM_CLASS}>
            <AccordionTrigger className="min-h-14 px-5 py-[18px]">
              <span className="flex items-center gap-2.5">
                <span className="size-2 shrink-0 rounded-full" style={{ background: r.dot }} />
                <span className="font-serif text-[22px] leading-none">{r.title}</span>
                {filled ? (
                  <Badge variant="sage" className="group-data-[state=open]:hidden">
                    Selected
                  </Badge>
                ) : null}
              </span>
            </AccordionTrigger>
            <AccordionContent className="px-[18px] pb-4">
              <Textarea
                value={value}
                onChange={(e) => onChange(r.id, e.target.value)}
                placeholder={r.placeholder}
                rows={4}
              />
              <div className="text-muted-foreground mt-2 text-right text-[11px] tabular-nums">
                {value.length} chars
              </div>
            </AccordionContent>
          </AccordionItem>
        );
      })}
    </Accordion>
  );
}
