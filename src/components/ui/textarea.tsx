import type * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "bg-card-soft placeholder:text-muted-foreground flex min-h-24 w-full resize-none rounded-xl px-4 py-3 text-sm leading-relaxed shadow-[var(--shadow-border)] transition-[background-color,box-shadow,color] duration-150 outline-none focus-visible:bg-card focus-visible:ring-[3px] focus-visible:ring-ring/10 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
