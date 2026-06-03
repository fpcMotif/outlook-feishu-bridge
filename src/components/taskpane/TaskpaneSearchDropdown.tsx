/* eslint-disable max-lines-per-function */
import { useId, useRef } from "react"
import type { ReactNode } from "react"

import { TaskpaneSearchField } from "./TaskpaneSearchField"
import { useTaskpaneSearchKeyboard } from "./taskpaneSearchKeyboard"

export function TaskpaneSearchDropdown({
  label,
  value,
  onChange,
  placeholder,
  open,
  listLabel,
  emptyMessage,
  onEscape,
  children,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  open: boolean
  listLabel: string
  emptyMessage: string
  /** When set, Escape delegates here instead of always clearing the query. */
  onEscape?: () => void
  children?: ReactNode
}) {
  const listId = useId()
  const optionPrefix = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const { onKeyDown, activeDescendantId } = useTaskpaneSearchKeyboard(
    listRef,
    optionPrefix,
    open,
    value,
    onEscape ?? (() => onChange("")),
  )

  return (
    <div className="relative">
      <TaskpaneSearchField
        label={label}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        expanded={open}
        controlsId={listId}
        activeDescendantId={activeDescendantId}
        onKeyDown={onKeyDown}
      />
      {open ? (
        <div
          ref={listRef}
          id={listId}
          aria-label={listLabel}
          className="bg-popover text-popover-foreground absolute inset-x-0 top-[calc(100%+0.45rem)] z-40 max-h-64 overflow-y-auto rounded-2xl p-1.5 shadow-float"
        >
          <div className="text-muted-foreground px-2 py-1.5 text-[11px] font-semibold tracking-wide uppercase">
            {listLabel}
          </div>
          <div className="space-y-1.5">
            {children ?? (
              <div className="text-muted-foreground rounded-xl p-3 text-sm">{emptyMessage}</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
