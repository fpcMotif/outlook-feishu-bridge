import type { KeyboardEventHandler, ReactNode } from "react";
import { Search } from "lucide-react";

export function TaskpaneSearchField({
  label,
  value,
  onChange,
  placeholder,
  rightSlot,
  expanded,
  controlsId,
  activeDescendantId,
  onKeyDown,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  rightSlot?: ReactNode;
  // Combobox a11y wiring for the search dropdowns (ADR-0013). Optional so other
  // callers stay a plain search box.
  expanded?: boolean;
  controlsId?: string;
  activeDescendantId?: string;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
}) {
  const isCombobox = controlsId !== undefined;
  return (
    <div className="bg-background flex h-11 items-center gap-3 rounded-xl px-3 shadow-edge transition-[box-shadow] duration-150 focus-within:ring-[3px] focus-within:ring-ring/20">
      <span className="text-primary flex size-8 shrink-0 items-center justify-center" aria-hidden="true">
        <Search className="size-4" />
      </span>
      <input
        type="search"
        aria-label={label}
        role={isCombobox ? "combobox" : undefined}
        aria-expanded={isCombobox ? Boolean(expanded) : undefined}
        aria-controls={expanded ? controlsId : undefined}
        aria-activedescendant={expanded ? activeDescendantId : undefined}
        aria-autocomplete={isCombobox ? "list" : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="placeholder:text-muted-foreground h-11 min-w-0 flex-1 bg-transparent text-sm leading-5 outline-none"
      />
      {rightSlot}
    </div>
  );
}
