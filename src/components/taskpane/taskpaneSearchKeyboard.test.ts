import { describe, expect, it } from "vitest"

import { resolveTaskpaneSearchKey } from "./taskpaneSearchKeyboard"

describe("resolveTaskpaneSearchKey", () => {
  it("moves down and wraps from the last option to the first", () => {
    expect(resolveTaskpaneSearchKey("ArrowDown", 3, -1)).toEqual({ kind: "move", index: 0 })
    expect(resolveTaskpaneSearchKey("ArrowDown", 3, 2)).toEqual({ kind: "move", index: 0 })
  })

  it("moves up and wraps from the first option to the last", () => {
    expect(resolveTaskpaneSearchKey("ArrowUp", 3, 0)).toEqual({ kind: "move", index: 2 })
    expect(resolveTaskpaneSearchKey("ArrowUp", 3, -1)).toEqual({ kind: "move", index: 2 })
  })

  it("selects the active option on Enter", () => {
    expect(resolveTaskpaneSearchKey("Enter", 3, 1)).toEqual({ kind: "select", index: 1 })
  })

  it("does nothing on Enter with no active option", () => {
    expect(resolveTaskpaneSearchKey("Enter", 3, -1)).toEqual({ kind: "none" })
  })

  it("closes on Escape", () => {
    expect(resolveTaskpaneSearchKey("Escape", 3, 0)).toEqual({ kind: "close" })
  })

  it("ignores unrelated keys", () => {
    expect(resolveTaskpaneSearchKey("a", 3, 0)).toEqual({ kind: "none" })
  })

  it("reports no active index for an empty option list", () => {
    expect(resolveTaskpaneSearchKey("ArrowDown", 0, -1)).toEqual({ kind: "move", index: -1 })
  })
})
