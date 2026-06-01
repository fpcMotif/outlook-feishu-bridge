# Extract-then-test seam — pure logic is unit-tested, registration/declarative glue is `v8-ignore`d

> **Status: accepted.** Codifies a convention the codebase already follows implicitly. Sets the boundary between code that must carry a direct unit test and framework glue that is coverage-ignored, so the 100 `react-doctor` / coverage bar reflects *logic correctness*, not framework wiring.

The project holds a hard coverage bar, but Convex function bodies, React components, schema, and crons mix two kinds of code:

- **Logic that can be wrong** — mapping fallback chains (`coworkerAvatarUrl`), reducers (`intakeReducer`), query normalizers/filters, token-expiry math, the `customerRowChanged` change-detection compare.
- **Declarative glue** — Convex `query`/`mutation`/`action` registration (the args validator + a handler that just wires `ctx` into the logic), `defineTable`/`crons` declarations, and React JSX that only renders props.

Testing the glue *through* its framework wrapper is high-cost, low-value (and this repo deliberately uses **no `convex-test`** harness). Not testing the logic is dangerous. Without a rule, coverage gets chased by either over-mocking wrappers or scattering `/* v8 ignore */` inconsistently — and a reader can't tell why one wrapper is ignored and the next isn't.

## Decision

- **Extract** branching/business logic into a pure, dependency-free function and unit-test it **directly**. Examples already in the tree: `coworkerAvatarUrl`, `mapFeishuUserToCoworker` / `mapCoworkers`, `intakeReducer`, `customerSearchHelpers`, `customerRowChanged`.
- **Inline + `/* v8 ignore */`** the thin wrapper whose only job is to wire that pure logic into a framework: Convex function *registration* (args validator + handler that calls the extracted fn and `ctx.db`/`ctx.runX`), `schema`/`crons` declarations, and React JSX with no branching.
- **The seam is the boundary:** one side is pure + tested; the other is glue + ignored. If a wrapper grows real branching, **extract that branch** rather than widening the ignore.
- **No `convex-test`.** Convex handlers are exercised by testing their extracted logic, not by booting a Convex test runtime.

## Consequences

- Coverage measures logic, not glue; the `react-doctor` 100 bar is met by testing extracted functions, with `v8-ignore` confined to declarative wrappers.
- The rule is legible: an ignored wrapper means "no logic here — see the extracted function," and logic always has a direct test.
- **Cost:** one extra named function (often its own file) per logic unit. Accepted — that indirection *is* the testable seam.
- PR #17 already followed this seam (the `avatar-image` and `coworkers` mapper tests, `intakeReducer`/`customerSearchHelpers` extractions); `main` absorbed the extractions, and those two tests merge on top of it.

## References

- [ADR-0016](0016-customer-search-modes-and-observability.md) — observability metrics emitted from the same Convex handlers this seam keeps thin.
- `react-doctor` (coverage + lint gate the seam is tuned for).
- Vitest / v8 coverage `/* v8 ignore */` directive.
