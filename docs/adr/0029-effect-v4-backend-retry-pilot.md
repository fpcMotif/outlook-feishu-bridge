# Effect v4 leaf-module pilot — typed retry in the Feishu transport

> **Status: accepted (pilot).** Introduces the [Effect](https://effect.website) v4 (beta) runtime as a backend dependency, scoped to one leaf module. Builds on [ADR-0019](0019-extract-then-test-seam.md) (extract-then-test: registered Convex handlers are `v8-ignore`d, business logic is unit-tested as pure helpers) and [ADR-0027](0027-deferred-attachment-fill.md) (the rate-limit-aware retry / `x-ogw-ratelimit-reset` honoring this helper implements). Pins `effect@4.0.0-beta.78`.

## Context

An external assessment recommended a **narrow, leaf-module pilot** of Effect rather than a repo-wide migration, targeting the modules that hand-roll timeout / retry / backoff / typed transport errors. The densest such module on the backend is `convex/feishu/call.ts`: `withFeishuRateLimitRetry` is a pure, dependency-injected helper (`fn` and `sleep` are injected) that retries **only** the Feishu rate-limit / in-flight-dedup codes (`1254290`, `1254608`, `99991400`) with exponential backoff, honoring the server's reset hint. It is on the hot path of essentially every Bitable/Drive call and is already unit-tested via the ADR-0019 seam.

Two facts shaped the decision:

1. **"v4" means Effect v4, which is beta.** The `effect` package's `latest` tag is v3 (`3.x`); v4 ships under the `beta` dist-tag (`4.0.0-beta.78` at time of writing) out of the [`Effect-TS/effect-smol`](https://github.com/Effect-TS/effect-smol) repo. The brief explicitly required v4, not v3.
2. **Effect v4 once broke inside Convex's restricted runtime.** [effect-smol#1404](https://github.com/Effect-TS/effect-smol/issues/1404) reported the fiber runtime's `keepAlive` calling `globalThis.setInterval(...)` on the `Effect.runPromise` async boundary in **beta.10**, which Convex queries/mutations reject ("Can't use setInterval"). Source inspection of **beta.78** shows the only `setInterval` left in core is in `Runtime.makeRunMain` — which `Effect.runPromise` does **not** use — and it is `try/catch`-guarded regardless. So our usage (`Effect.runPromise` from a Convex **action**) does not install that timer. The issue is closed and appears fixed for this path.

## Decision

- **Live-path swap, one module.** `withFeishuRateLimitRetry` is re-implemented over Effect v4 and keeps its **exact public contract** — `(fn, opts) => Promise<T>`. A new `withFeishuRateLimitRetryEffect(fn, opts): Effect.Effect<T, unknown>` holds the logic (`Effect.tryPromise` → `Effect.catchIf` retry-only-rate-limit → `Effect.promise(sleep)` → recurse); the public function is the thin boundary `Effect.runPromise(withFeishuRateLimitRetryEffect(...))`. No caller signature changes.
- **Use v4 idioms, not the v3 names.** `catchAll` is `catch` in v4 and `catchSome` is gone; we use `catchIf` (unchanged in v4), whose non-matching branch re-raises the error untouched — exactly the "retry only these codes, rethrow everything else" semantics.
- **Identity is preserved across the boundary.** `Effect.runPromise` rejects via `Cause.squash`, which returns the original failure value. Because `tryPromise`'s `catch` maps the rejection straight into the error channel, callers still receive the **same `FeishuError` instance** — `instanceof FeishuError` and `.code` checks (in `bitable.ts`, the `attachmentFill` suite) keep working. A test asserts `.rejects.toBe(originalError)` to lock this.
- **Tested at the Effect boundary (ADR-0019).** `convex/feishu/call.effect.test.ts` runs in plain vitest in Node with injected `fn`/`sleep` — no Convex runtime, no real timers — covering hint-vs-backoff, the three retry codes, non-retryable passthrough, `maxAttempts` exhaustion, and instance identity.
- **Pin the beta exactly.** `effect` is pinned to `4.0.0-beta.78` (no caret) because the Effect team warns betas may break between releases.
- **Tooling.** `@effect/language-service` is added as a dev dependency and wired as a `plugins` entry in `convex/tsconfig.json` (editor-only; the batch type-checker ignores it). The v4 reference (`effect-smol`) and the community **`effect-v4`** agent skill (MIT, `teeverc/effect-ts`, tracked in `skills-lock.json`) support further v4 work.

## Considered options

- **Parallel proof (add the Effect helper but leave the live function unchanged until a deploy verifies the isolate).** Lowest blast radius, but defers the actual integration the brief asked for; rejected in favor of the live swap since the source evidence for beta.78 isolate-compat is strong and the contract/behavior are preserved.
- **Frontend pilot first (`src/office/attachmentUpload.ts`).** The browser/WebView is actually a friendlier runtime for the beta than Convex's isolate, but the assessment explicitly deferred the frontend (bundle/host risk), and the backend module has the higher retry-logic density.
- **No-library cleanup** (factor the manual retry/error taxonomy into a shared helper without Effect). Captures some upside with no new dependency; rejected because the brief required an Effect v4 pilot specifically.
- **Effect v3.** Rejected — the brief required v4.

## Consequences

- `effect` (beta) is now a backend runtime dependency bundled into the Convex deployment. It is a moving target; the exact pin localizes churn, and the pilot's single-module scope localizes blast radius.
- **Deploy-verification gap.** The Convex-isolate behavior of `Effect.runPromise` was verified by **source analysis of beta.78**, not by a live deploy (no credentials in the build environment). Before relying on this in production, run `bunx convex dev` / deploy and exercise a throttled Feishu call to confirm no `setInterval`/runtime rejection. If the isolate rejects it, revert this module to the previous `for`-loop (preserved in git history) — the public contract is unchanged, so the revert is local.
- A small async-scheduling nuance: the Effect form invokes `fn` on a microtask via `runPromise` rather than synchronously within the first tick. No observed caller depends on synchronous first-call timing (the regression suites pass).
- `bun run lint` has **pre-existing** pedantic debt on `main` unrelated to this change; the new files lint clean under the same flags.

## Deferred

- Extending the pattern to the next leaf modules the assessment named — `convex/feishu/client.ts` (`feishuFetchEffect`) and `convex/m365/selfForwardChain.ts` — only after this pilot proves out on a real deployment.
- The frontend upload path (`src/office/attachmentUpload.ts`), pending backend results and bundle-size review.
- Re-evaluating breadth of adoption once Effect v4 leaves beta.
