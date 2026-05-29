import type { ReactNode } from "react";
import { Search } from "lucide-react";

export function TaskpaneSearchField({
  label,
  value,
  onChange,
  placeholder,
  rightSlot,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  rightSlot?: ReactNode;
}) {
  return (
    <div className="bg-background flex h-11 items-center gap-3 rounded-xl pr-3 pl-0 shadow-[var(--shadow-border)] transition-[box-shadow] duration-150 focus-within:ring-[3px] focus-within:ring-ring/10">
      <span className="text-primary flex size-8 shrink-0 items-center justify-center" aria-hidden="true">
        <Search className="size-4" />
      </span>
      <input
        type="search"
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="placeholder:text-muted-foreground h-11 min-w-0 flex-1 bg-transparent text-sm leading-5 outline-none"
      />
      {rightSlot}
    </div>
  );
}
