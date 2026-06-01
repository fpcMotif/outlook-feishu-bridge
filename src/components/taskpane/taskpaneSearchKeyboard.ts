import { useEffect, useState } from "react"
import type { KeyboardEvent, RefObject } from "react"

// Pure keyboard-navigation resolver for the taskpane search dropdowns
// (CoworkerPicker / CustomerPicker). Given the pressed key, the option count in
// render order, and the active index, it returns the next action. Kept free of
// the DOM so it is unit-testable in isolation.

export type TaskpaneSearchKeyAction =
  | { kind: "move"; index: number }
  | { kind: "select"; index: number }
  | { kind: "close" }
  | { kind: "none" }

function wrap(index: number, length: number): number {
  if (length === 0) return -1
  if (index < 0) return length - 1
  if (index > length - 1) return 0
  return index
}

export function resolveTaskpaneSearchKey(
  key: string,
  optionCount: number,
  activeIndex: number,
): TaskpaneSearchKeyAction {
  if (key === "ArrowDown") return { kind: "move", index: wrap(activeIndex + 1, optionCount) }
  if (key === "ArrowUp") return { kind: "move", index: wrap(activeIndex - 1, optionCount) }
  if (key === "Escape") return { kind: "close" }
  if (key === "Enter") {
    return activeIndex >= 0 && activeIndex < optionCount
      ? { kind: "select", index: activeIndex }
      : { kind: "none" }
  }
  return { kind: "none" }
}

// Roving active-descendant over the option buttons rendered as children inside
// `listRef` (marked with [data-search-option]). Returns the input keydown
// handler and the id of the active option for aria-activedescendant.
export function useTaskpaneSearchKeyboard(
  listRef: RefObject<HTMLDivElement | null>,
  optionIdPrefix: string,
  open: boolean,
  query: string,
  onClose: () => void,
) {
  const [activeIndex, setActiveIndex] = useState(-1)

  const options = () =>
    listRef.current
      ? Array.from(listRef.current.querySelectorAll<HTMLButtonElement>("[data-search-option]"))
      : []

  useEffect(() => {
    setActiveIndex(-1)
  }, [query, open])

  useEffect(() => {
    const buttons = options()
    buttons.forEach((button, index) => {
      button.id = `${optionIdPrefix}-${index}`
      button.setAttribute("aria-selected", index === activeIndex ? "true" : "false")
    })
    // scrollIntoView is unimplemented in jsdom; guard so tests + SSR stay safe.
    if (activeIndex >= 0) buttons[activeIndex]?.scrollIntoView?.({ block: "nearest" })
  })

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open) return
    const buttons = options()
    const action = resolveTaskpaneSearchKey(event.key, buttons.length, activeIndex)
    if (action.kind === "none") return
    event.preventDefault()
    if (action.kind === "move") setActiveIndex(action.index)
    if (action.kind === "select") buttons[action.index]?.click()
    if (action.kind === "close") {
      onClose()
      setActiveIndex(-1)
    }
  }

  const activeDescendantId = activeIndex >= 0 ? `${optionIdPrefix}-${activeIndex}` : undefined

  return { onKeyDown, activeDescendantId }
}
