import type * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "bg-card-soft placeholder:text-muted-foreground flex h-10 w-full min-w-0 rounded-xl px-3.5 py-2 text-sm shadow-edge transition-[background-color,box-shadow,color] duration-150 outline-none focus-visible:bg-card focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
