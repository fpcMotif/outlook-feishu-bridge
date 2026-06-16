# Tenant-token cache is a single canonical row (first-committer-wins), not delete-all + insert

> **Status: accepted.** Fixes a recurring `occRetried` Health Insight on the dev deployment (`steady-setter-706`): `feishu/auth:storeToken` **retried due to a write conflict in `feishuTokens` against itself** (`occ_write_source = storeToken`, i.e. "vs Self"), surfacing roughly weekly. `storeToken` now enforces a **single-canonical-row** invariant and writes the token **in place** (patches a stable `_id`); when a still-fresh row already exists a concurrent refresh becomes a **no-op** (first-committer-wins). `getTenantAccessToken` treats the cache write as **best-effort**. No new cron (forbidden by [crons.ts](../../convex/crons.ts)). Extends the extract-then-test seam ([ADR-0019](0019-extract-then-test-seam.md)).

## Incident — `storeToken` conflicts with itself, ~weekly

The Feishu **tenant access token** is cached in the single-row `feishuTokens` table and expires ~every 2h (`expire − 300` s, [auth.ts](../../convex/feishu/auth.ts)). `getTenantAccessToken` runs on **every** tenant-authed Feishu call that doesn't pass a pre-resolved `token` ([call.ts](../../convex/feishu/call.ts) `resolveFeishuToken`). So when the cache goes cold, a *burst* of concurrent actions each: miss the cache → fetch a fresh token from Feishu → call `storeToken`.

The original `storeToken` read the whole table (`take(10)`), **deleted every row, then inserted a new one**. Two such executions running in parallel read and write the same rows of `feishuTokens`, so Convex's [optimistic concurrency control](https://docs.convex.dev/database/advanced/occ) detects a conflict and retries. Worse, because every successful store changes the table's contents (a brand-new `_id` each time), it is *guaranteed* to invalidate any concurrent peer — a small stampede cascades through retries. It surfaces ~weekly because that's how often a multi-caller burst happens to coincide with the ~2h cold-cache window.

Telemetry framing: the Insight is `occRetried` / severity **warning** with `retry_count = 0` — Convex auto-retried and **succeeded**. This is benign contention noise today, but the Insight warns it "will eventually fail permanently if the conflicts persist," and it is pure waste (N parallel token fetches + a retry cascade for one logical refresh).

## Decision

### 1. Single-canonical-row, written in place

`storeToken` delegates to a pure planner `planTokenStore(rows, now)` ([auth.ts](../../convex/feishu/auth.ts)) that returns one of `skip` / `patch` / `insert` plus the ids to prune:

- **A still-fresh row exists → `skip`** (first-committer-wins). A peer refresh already cached a valid token; we do not write. A loser's OCC retry re-reads the now-fresh row and lands in this branch as a **read-only no-op**, so it settles in *one* retry instead of cascading. The longest-lived fresh row is kept (deterministic regardless of scan order; max validity headroom); any stragglers are pruned.
- **All rows stale (or none) → `patch` one in place / `insert`** if empty, pruning the rest. Patching a stable `_id` means even two *simultaneous* cold-cache writers contend on a **single document**, which Convex's automatic OCC retry resolves cleanly — no table-churn cascade.

`now` is read with `Date.now()` *inside* the handler so the writer's freshness clock matches `getCachedToken`'s reader clock (strict `>` boundary, shared with `selectFreshToken`).

### 2. Best-effort cache write

`getTenantAccessToken` already holds the freshly-fetched token when it calls `storeToken`, so the cache write is wrapped in `try/catch`: a store failure (e.g. an OCC conflict that out-survives Convex's auto-retries) is logged (secret-safe — reason only, never the token) and the call proceeds. Acquiring a token no longer depends on caching it.

### 3. No cron

A proactive token-refresh cron would also avoid the cold-cache stampede, but `crons.ts` deliberately limits scheduled work to the two directory mirrors ("do not add a cron without a clear reason"). The in-mutation fix needs none.

## What this does and does NOT do (honest scope)

- **Does:** eliminate the *delete/insert churn cascade*; collapse a refresh burst to one effective write; make every loser a one-retry no-op; keep the call resilient even if a store fails. The weekly warning should clear.
- **Does NOT:** make a *truly simultaneous* first collision physically impossible — two writers that both read a cold cache in the same instant still contend once on the single canonical row. That single contention is exactly what Convex's auto-retry (already succeeding here) is for; it can no longer cascade toward permanent failure.
- **Heavier alternative, deferred:** a DB **single-flight lease** (the precedent in [ADR-0021 §3](0021-customer-mirror-prune-and-event-sync.md) `startRefreshIfAllowed`) would give a hard "exactly one refresh in flight" guarantee, but is over-engineering for a benign warning on a cheap fetch. Recorded as the escalation path if `occFailedPermanently` ever appears.

## Consequences

- **Schema.** `feishuTokens` is documented as a single-canonical-row, intentionally-unindexed cache ([schema.ts](../../convex/schema.ts)). No migration: existing deployments already hold one row, and `planTokenStore` self-prunes any strays on the next refresh.
- **Tests.** `planTokenStore` is unit-tested per ADR-0019 (insert / patch / skip / fresh-not-first / multi-fresh-keeps-longest / all-stale-prune / `expiresAt === now` boundary / one-survivor property). A `getTenantAccessToken` test pins the best-effort store (returns the token even when `storeToken` throws). The dead `pruneTokenRows` helper is removed. Run scoped: `bunx vitest run convex/feishu/auth.test.ts`.
- **Related, now done in a follow-up:** `storeUserToken` ([userAuth.ts](../../convex/feishu/userAuth.ts)) had the same delete-then-insert shape but is keyed **by `sessionId`** via the `by_sessionId` index, so concurrent stores for *different* sessions touch different documents and never conflict; only two concurrent refreshes of the *same* session could, which is rare. It has since been converted to patch-in-place behind a pure `planUserTokenStore` planner (same extract-then-test seam, [ADR-0019](0019-extract-then-test-seam.md)), removing the residual same-session OCC risk and keeping the two store paths consistent. `patch` is a shallow merge, so a refresh that omits the optional `userName`/`avatarUrl` keeps the last-known values rather than clearing them (Convex `patch` ignores `undefined`) — the intended state, since the same user owns the session across refreshes.

## References

- Convex OCC / write-conflict error: https://docs.convex.dev/error#optimistic-concurrency-control
- Convex OCC deep-dive: https://docs.convex.dev/database/advanced/occ
- [ADR-0019](0019-extract-then-test-seam.md) — extract-then-test seam (why the planner is a pure helper)
- [ADR-0021 §3](0021-customer-mirror-prune-and-event-sync.md) — single-flight lease precedent (the deferred heavier alternative)
