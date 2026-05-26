import type * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-input bg-card-soft placeholder:text-muted-foreground flex min-h-24 w-full resize-none rounded-xl border px-4 py-3 text-sm leading-relaxed shadow-sm transition-[background-color,border-color,box-shadow] outline-none focus-visible:border-input focus-visible:bg-card focus-visible:ring-[3px] focus-visible:ring-black/5 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
