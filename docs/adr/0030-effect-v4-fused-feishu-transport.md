# Effect v4 step 2 — fused Feishu transport pipeline (call budget + typed retry)

> **Status: accepted.** Extends the [ADR-0029](0029-effect-v4-backend-retry-pilot.md) pilot from the retry helper to the whole **Feishu Transport** (`convex/feishu/client.ts`) and fuses `callFeishu` (`convex/feishu/call.ts`) into one Effect pipeline. **Stacked on the un-merged pilot branch by owner decision, consciously waiving ADR-0029's "extend only after the pilot proves out on a real deployment" gate.** Builds on [ADR-0019](0019-extract-then-test-seam.md) (extract-then-test) and [ADR-0027](0027-deferred-attachment-fill.md) (rate-limit-aware retry).

## Context

ADR-0029's Deferred section named `convex/feishu/client.ts` as the next candidate. An evaluation of all candidates confirmed it as the highest-leverage step:

- **It is the single choke point.** Every Bitable record write, Drive upload, token bootstrap/refresh, and contact search crosses `feishuFetch`. Hardening one ~120-line leaf (no Convex imports, mocked-fetch tested) hardens every Feishu interaction.
- **It had a real robustness hole, not a style problem.** There was **no timeout and no abort**: a hung Feishu socket pinned the whole Convex action — and with it a Base Sync attempt — until the platform killed it.
- **Its failure taxonomy was untyped but load-bearing.** `FeishuError` (envelope), the `-1` non-JSON sentinel (which `classifyRefreshError` in `userAuth.ts` depends on — `-1` → transient, real code → terminal), and raw network throws all left as untyped exceptions; the outbox's `isPermanentBitableSyncError` string-matches `FeishuError` messages.
- The runners-up scored worse: `m365/selfForwardChain.ts` already hand-rolls a typed `SelfForwardResult` union and is soft-fail by design; `bitableSyncRetry.ts` / `attachmentFill.ts` are pure planners whose *durable* retries live in Convex's scheduler (`runAfter`), which an in-process `Effect.Schedule` cannot replace; the frontend upload path stays deferred (bundle/host risk).

Meanwhile main moved: PR #62 refactored `call.ts` around a shared `isFeishuRateLimited` classifier, so the pilot branch already conflicts with main in exactly that file.

## Decision

- **Typed transport.** `feishuFetchEffect(opts): Effect.Effect<T, FeishuError | FeishuTimeoutError>` holds the transport logic. Expected failures live in the error channel; unexpected transport failures (network/DNS) stay **defects**, so the Promise boundary rethrows the **original instance** (locked by test). The `-1` non-JSON sentinel and all log strings are byte-preserved.
- **Bounded call budget.** Every exchange runs under `timeoutMs` (default `DEFAULT_FEISHU_TIMEOUT_MS` = 30 000; Drive `upload_all` overrides with `DRIVE_UPLOAD_TIMEOUT_MS` = 120 000 for ≤20 MB multipart bodies). The budget is enforced with `Effect.timeoutOrElse` **and a real `AbortSignal` into `fetch`** — on timeout the fiber is interrupted *and the socket torn down*, not orphaned.
- **A blown budget is `FeishuTimeoutError`, deliberately NOT a `FeishuError`** and **never retried in-process**: it carries no Feishu business code, so the rate-limit classifier can't match it, and replaying a 30 s stall inside the action would multiply action runtime. It fails fast into the layers already built for transients — the Request sync outbox re-schedules durably, `classifyRefreshError` treats any non-`FeishuError` as transient, Attachment Fill defers the file.
- **Fused call pipeline.** `callFeishuEffect(ctx, opts)` composes token-resolve → transport → `data`-unwrap as one Effect; `callFeishu` keeps its exact `(ctx, opts) => Promise<T>` contract as a thin `Effect.runPromise` boundary (the `vi.mock`-based suites are untouched).
- **Retry is now a call option.** `CallFeishuOptions.retry?: true | FeishuRetryOptions` composes the new Effect-native `retryFeishuRateLimit` around the **whole** sequence, so each attempt **re-resolves the token** — exactly the semantics of the old call-site `withFeishuRateLimitRetry(() => callFeishu(…))` wrap (locked by test). The four `bitable.ts` sites migrated to `retry: true`; `withFeishuRateLimitRetry`/`withFeishuRateLimitRetryEffect` remain exported (the latter now a Promise-thunk seam over `retryFeishuRateLimit`).

## Considered options

- **Transport-only (keep `call.ts` untouched).** Lower rebase cost — `call.ts` is the exact PR #62 conflict surface — but leaves retry composing over the Promise boundary through nested runtime entries. Rejected by the owner in favor of the full fusion now.
- **Rebase + live-verify + merge the pilot first.** The sequencing ADR-0029 itself prescribed. Rejected by the owner: stack on the pilot branch now.
- **In-process-retryable timeouts.** Rejected — see Decision; the durable layers own slow-path recovery.
- **`Effect.Schedule` for backoff.** Rejected for this step: the hand-rolled recursion is already proven by the pilot's tests, and Schedule adds API surface without changing behavior.

## Consequences

- **The stack's rebase debt is now deliberate and known.** `call.ts` diverges further from main's PR #62; at rebase time `retryFeishuRateLimit`'s predicate should be re-expressed over main's `isFeishuRateLimited`, and main's unified Drive retry reconciled (this branch leaves `drive.ts`'s local loop untouched).
- **The ADR-0029 deploy-verification gap now covers two modules.** Still unverified on a live Convex deploy (no credentials here): run `bunx convex dev` and exercise a throttled + a slow Feishu call before production reliance. Revert stays per-module and local — every public contract is unchanged.
- **Behavior change (intended):** calls that previously hung indefinitely now fail within their budget with `FeishuTimeoutError`; durable retry takes over. A genuinely-slower-than-30 s non-upload call would newly fail — no such call is known (per-call `[feishu] … ms` logs run well under it); the per-call override exists if one appears.
- `feishuFetch` rejections gain one new type (`FeishuTimeoutError`) that callers' `instanceof FeishuError` checks intentionally do **not** match.

## Deferred

- `convex/m365/selfForwardChain.ts` and the frontend upload path (`src/office/attachmentUpload.ts`) — unchanged from ADR-0029's list.
- Re-expressing the retry predicate over main's `isFeishuRateLimited` (rebase-time, not now).
- Effect `Schedule`/`Layer`/service adoption — revisit once v4 is stable and the stack has survived a real deploy.
