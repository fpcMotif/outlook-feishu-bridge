# Mission: Reliable Convex ↔ external-source sync (Customer Mirror)

## Why
You maintain a Convex `customers` mirror of the Feishu Bitable customer-info table. On 2026-06-01 it drifted to ~3× the source because it was keyed on a mutable column. You want to never ship that bug again — and to be able to design a drift-free mirror for *any* external source you read into Convex.

## Success looks like
- For any external-source mirror, you can name **which field to key on** and justify it in one sentence (the "never changes" test).
- You can explain, unprompted, why keying on the Bitable **"Record Id" column** caused the 3× drift and why the API **`record_id`** fixes it.
- You can design the **upsert + reconcile** pair (idempotent upsert on a stable key, plus a prune for deletes) and say why a timestamp won't work in Convex.

## Constraints
- Real production code in `outlook-sales` (Convex + Feishu Bitable). Use bun/bunx.
- Official sources only (Convex docs, Feishu docs) — no third-party wrappers.
- Tight scope: the *key choice* and the *upsert+reconcile* shape, nothing broader.

## Out of scope (for now)
- Real-time Feishu event-sync webhooks (deferred in ADR-0021).
- Multi-source-of-record key collisions (you have exactly one source of record).
- Convex Aggregate component / search-index internals.
