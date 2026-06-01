import type { ReactNode } from "react";

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

/** Shared selected-state row for Customer and Coworker in the intake card stack. */
export function TaskpaneSelectionRow({
  icon,
  leading,
  label,
  onChange,
  changeLabel = "Change",
  dataRow,
}: {
  /** Lucide or custom icon in the muted icon slot. */
  icon?: ReactNode;
  /** Avatar or other leading visual; replaces the icon slot when set. */
  leading?: ReactNode;
  label: string;
  onChange?: () => void;
  changeLabel?: string;
  dataRow?: "customer" | "coworker";
}) {
  const rowProps = dataRow ? { [`data-${dataRow}-row`]: "true" as const } : {};

  return (
    <div
      className="flex min-h-14 min-w-0 items-center gap-3 px-3 py-2"
      {...rowProps}
    >
      <SelectionRowLeading leading={leading} icon={icon} />
      <span className="min-w-0 flex-1 whitespace-normal break-words text-xs leading-4 font-semibold">
        {label}
      </span>
      {onChange ? (
        <button
          type="button"
          onClick={onChange}
          className="text-primary inline-flex min-h-8 items-center rounded-md px-2 text-[11px] font-semibold"
        >
          {changeLabel}
        </button>
      ) : null}
    </div>
  );
}
