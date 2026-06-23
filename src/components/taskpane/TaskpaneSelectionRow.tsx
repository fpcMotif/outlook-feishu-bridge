import type { ReactNode } from "react";
import { ArrowRightLeft } from "lucide-react";

import { cn } from "@/lib/utils";

function SelectionRowLeading({ leading, icon }: { leading?: ReactNode; icon?: ReactNode }) {
  const left = leading ?? icon;
  if (!left) return null;

  return (
    <span
      className={
        leading
          ? "flex size-8 shrink-0 items-center justify-center"
          : "text-muted-foreground flex size-8 shrink-0 items-center justify-center"
      }
      aria-hidden="true"
    >
      {left}
    </span>
  );
}

function SelectionRowChange({ onChange, changeLabel }: { onChange?: () => void; changeLabel: string }) {
  if (!onChange) return null;

  return (
    <button
      type="button"
      onClick={onChange}
      aria-label={changeLabel}
      className="text-primary/85 hover:bg-primary/10 hover:text-primary inline-flex size-10 shrink-0 items-center justify-center rounded-full outline-none transition-[background-color,color,transform] duration-150 ease-[var(--ease-out-strong)] active:scale-[0.97] focus-visible:ring-[3px] focus-visible:ring-ring/20"
    >
      <ArrowRightLeft className="size-4" strokeWidth={2} aria-hidden="true" />
    </button>
  );
}

/** Shared selected-state row for Customer and Coworker in the intake card stack. */
export function TaskpaneSelectionRow({
  icon,
  leading,
  label,
  onChange,
  changeLabel = "Pick another",
  dataRow,
  enterStagger = false,
  inset = true,
}: {
  /** Lucide or custom icon in the muted icon slot. */
  icon?: ReactNode;
  /** Avatar or other leading visual; replaces the icon slot when set. */
  leading?: ReactNode;
  label: string;
  onChange?: () => void;
  changeLabel?: string;
  dataRow?: "customer" | "sales" | "coworker";
  /** Staggered ease-out enter when the system applies a default selection. */
  enterStagger?: boolean;
  /** Keep default row padding when rendered directly in a card stack. */
  inset?: boolean;
}) {
  const rowProps = dataRow ? { [`data-${dataRow}-row`]: "true" as const } : {};
  const rowSpacing = inset ? "px-3 py-2" : "px-3 py-1";
  const minHeight = inset ? "min-h-14" : "min-h-11";

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-3",
        minHeight,
        rowSpacing,
        !inset && "bg-background rounded-xl shadow-edge",
        enterStagger && "taskpane-selection-enter-group",
      )}
      {...rowProps}
    >
      <SelectionRowLeading leading={leading} icon={icon} />
      <span className="min-w-0 flex-1 whitespace-normal break-words text-xs leading-4 font-semibold">
        {label}
      </span>
      <SelectionRowChange onChange={onChange} changeLabel={changeLabel} />
    </div>
  );
}
