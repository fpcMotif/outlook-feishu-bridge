import type * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "bg-card-soft flex min-h-24 w-full resize-none rounded-xl px-4 py-3 text-sm leading-relaxed shadow-edge transition-[background-color,box-shadow,color] duration-150 outline-none placeholder:text-xs placeholder:font-light placeholder:text-muted-foreground/65 placeholder:italic focus-visible:bg-card focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
