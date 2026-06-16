# Sales is written as a follow-up PUT after the Service-row create, never on it

---
Status: accepted
---

The Base **Service** row is created with `Data From = Email` and every other field
in the first `POST …/records`, then the **Sales** User column is set in a
**second `PUT …/records/{id}`** against the just-created row — never in the create
payload (`buildServiceCreateFields` deliberately omits `Sales`;
`buildServiceSalesFields` is the phase-2 patch; see
[`convex/feishu/serviceRow.ts`](../../convex/feishu/serviceRow.ts) and
[`convex/feishu/bitable.ts`](../../convex/feishu/bitable.ts) `createServiceRecord`).
This two-step is intentional: writing the Sales User column in the same call as
the create did **not link reliably** — the row has to exist (and its create-time
Base automations settle) before the User link binds. Recorded so the cost is
never mistaken for an accident (commit `75a055c`: *"create the service row with
Main Email first, then patching Sales so Feishu links correctly"*).

## Considered options

- **Merge `Sales` into the create `POST` (one call instead of two).** Rejected —
  it re-introduces the exact bug `75a055c` fixed: the Sales User column ends up
  unlinked / blank on the new row. The extra round-trip is the price of a correct
  Sales link. (Corrections via `correctServiceRecord` *do* write create-fields +
  Sales in one `PUT`, because that row already exists — which is consistent with
  "the row must exist first," not a counter-example.)

## Consequences

- The **"Syncing to Feishu Base"** wait is ≈4 s and is **fundamentally two serial
  cross-border Feishu writes** (create `POST` ~2 s + Sales `PUT` ~2 s), not a UI
  problem. Do **not** try to shed it by collapsing the two calls.
- The slowest leg was already moved off this path: attachments are a **deferred
  Attachment Fill** after the row exists ([ADR-0027](0027-deferred-attachment-fill.md)),
  not part of the create wait.
- The Customer-Mirror **kick** ([ADR-0016](0016-customer-search-modes-and-observability.md))
  is background / fire-and-forget and does **not** contribute to this latency, so
  it was intentionally left as-is rather than "optimized" for a non-win.
