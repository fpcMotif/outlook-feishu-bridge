# Customer matching: preloaded Customer Directory + inline Customer Picker

> **Status: accepted.** Extends [ADR-0012](0012-bitable-record-api.md) (Base record API + Client linkage by domain match) and [ADR-0011](0011-feishu-permission-set.md) (permissions); amends [CONTEXT.md](../../CONTEXT.md) language ("Client" → **Customer**).

Until now, the Base Service row's `Client` DuplexLink was set by a single server-side, tenant-token search of the **Customer Table** (`tbl4TE2GV472sKzp`) on the email sender's domain — silent, invisible to the user, lenient on no-match. The plan to let a salesperson **see** the match and **override** it was deferred at the time of [ADR-0012](0012-bitable-record-api.md). This ADR is that follow-through.

## Decision

- **Customer Directory: preload on login.** The SPA fires one tenant-token paged read of the Customer Table (`POST /bitable/v1/apps/{app_token}/tables/tbl4TE2GV472sKzp/records/search`) right after login, and caches a slim projection in memory for the session. The cache is **never persisted to localStorage** — login is the freshness boundary.
- **Projection shape (7 fields, written once and frozen):** `{ recordId, name, domain, fullName, accountNo, countryRegion, owner }` — mapped from `record_id`, `Account Name`, `域名`, `全名`, `Account No.`, `Country and Regio`, and the first `Owner` user (`{ openId, name }`). Other Customer Table columns are intentionally dropped.
  - The Customer Table currently holds **~250 rows** (live count May 2026); the goal accommodates growth to ~5000. At 5000 the projection is ≈600 KB raw / ~120 KB gzipped — well within taskpane budgets.
  - `Account Name` and `域名` are returned by Feishu as **rich-text arrays** `[{text, type}]`; the server flattens to plain strings before projecting.
- **Non-blocking preload.** The auth flow does not await the directory load; the picker degrades gracefully — "Loading customer directory…" + the server-side fallback (below) accepting keystrokes until the directory arrives.
- **Local search** over `name`, `fullName`, `accountNo`, `domain`, `countryRegion`. The first implementation uses simple case-insensitive substring matching; upgrade to Fuse.js if rank quality becomes a real issue at ~5000 rows. No UI library beyond the existing shadcn primitives.
- **Server-side per-keystroke search as fallback.** A parallel public action `searchCustomers(query)` runs a Base `records/search` with `operator: "contains"` filters against `Account Name` + `域名` and returns the same projection shape. Used (a) before the directory finishes preloading, (b) if the preload fails, (c) for A/B comparison against the local Fuse path. Same projection — the UI doesn't care which path produced the rows.
- **Auto-match rule: exact equality, case-insensitive.** `senderDomain.toLowerCase() === customer.domain.toLowerCase()`. No suffix/subdomain heuristics, no Fuse-scored "best guess" — silently picking the wrong Customer is worse than no match.
- **No-match is lenient.** When the sender's domain matches no `域名`, the picker shows "No customer matched for `<domain>` — pick one" with a search affordance. Sync proceeds regardless; the `Client` field is left unlinked, exactly as [ADR-0012](0012-bitable-record-api.md) already allows.
- **Override always wins.** When the salesperson explicitly picks a Customer via the picker, that `recordId` overrides any domain auto-match for the sync.
- **Email Record audit trail.** The Convex Email Record gains `selectedCustomer: { recordId, name } | undefined`. Strictly additive; ~50 bytes/row. Lets future replays/audits answer "which Customer was this email linked to?" without re-fetching Base.
- **The `clientEmail` intake field is kept.** The editable Client Email input is the email that drives the backend's existing `matchClientRecordId` domain match (default `mailItem.from`, user-overridable). Removing it would also remove the salesperson's only way to *correct* a mis-typed or routed-through sender domain on the way to the backend match — which is still the fallback when the SPA can't resolve a Customer locally. `selectedCustomer` is **additive**, not a replacement.

## Why

- **The real job is structured triage, not data entry.** A salesperson opens an email from a known customer 95% of the time. Pre-resolving + showing the match makes that the one-tap case; the override exists for the long tail.
- **5000 rows is small.** Per-keystroke server search would cost 200-500 ms of round-trip and only matches one Base field at a time. Loading the whole projection once is cheaper than three keystrokes' worth of network.
- **Privacy is unchanged.** Any signed-in user could already open the live Base directly with the same data. Shipping the projection to the SPA exposes no new surface.
- **Predictable beats clever.** A case-insensitive `==` rule never picks the wrong customer silently. Sales prefers "no match" to "matched the wrong one".
- **HARD RULE preserved.** The Customer Picker only reads. It never creates, updates, or deletes a Customer row. The HARD RULE from [ADR-0010](0010-pivot-to-bitable-intake.md) / [ADR-0012](0012-bitable-record-api.md) — "never touch a pre-existing Base row" — is unchanged and reinforced here for the Customer Table.

## Consequences

- **No new Feishu scope.** `bitable:app` (tenant) already covers reading any table in the same Base ([ADR-0011](0011-feishu-permission-set.md)). The two new actions reuse the existing tenant-token path.
- **Customer Table schema is now part of the contract.** Field names `Account Name`, `Account No.`, `Branch`, `Owner`, `Country and Regio`, `Sales Service`, `域名`, `全名` are read by name; renaming them in Base breaks the SPA the next time someone logs in.
- **Email Record schema migration** required (additive: `selectedCustomer` optional). Old records remain valid.
- **Customer Directory staleness window.** A Customer added in Base mid-session is invisible until the next login. Accepted; refresh-on-login is enough for sales workflow cadence.
- **The `Client` column in the Service Base retains its literal name.** Renaming it to `Customer` is a Base-side schema change, outside the SPA's scope. Code and prose elsewhere use **Customer**; only the field-name string `"Client"` in `convex/feishu/bitable.ts` survives.
- **`clientEmail` stays in the intake action args** as the fallback domain-match input. The Customer Picker is additive: when it supplies `selectedCustomer.recordId`, that override wins; otherwise the backend still searches the Customer Table by `clientEmail` domain.

## Alternatives rejected

- **Server-side per-keystroke as the only path.** 200-500 ms per query; single-field `contains` filter; no rank quality. Kept only as a fallback.
- **Hard-require a Customer pick before sync.** Blocks the legitimate "new customer not yet in the table" case. Lenient stays.
- **Fuzzy-score domain + name + fullName auto-match.** Silently picks the wrong customer too often when domains don't match. Worse UX than "no match → pick one".
- **Persist the Customer Directory to localStorage.** Adds cache-invalidation complexity for ~120 KB; login is already the freshness boundary.
- **Include all 13 Customer Table fields in the projection.** Exposes the SPA to silent schema drift; 3x payload for fields the picker never displays.

## Out of scope (future work)

- **Creating a new Customer from the picker.** When the sender's domain has no match today, the picker opens directly on the Customer search panel so the salesperson can pick an existing Customer or sync unlinked. A future iteration will add a **"+ Add new customer"** affordance with two candidate paths:
  - **(a) Direct Base create** — `POST /bitable/v1/apps/.../tables/tbl4TE2GV472sKzp/records` from the SPA via a Convex tenant action. Crosses the line from "Customer Table is read-only" to "the add-in can create new Customer rows" — note the HARD RULE forbids *modifying* pre-existing rows but does *not* forbid creating new ones.
  - **(b) External Feishu form link** — open the existing Customer-onboarding Feishu form in a popup; the SPA waits for the directory refresh on next reload to see the new row.
  No decision yet on (a) vs (b). The current picker exposes create-customer only after a typed query has no matches, rather than reserving disabled placeholder space in the default no-match view.

## References

- Search records: https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/search
- List fields: https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-field/list
- Record data structure (rich-text + Lookup + User shapes): https://open.feishu.cn/document/docs/bitable-v1/app-table-record/bitable-record-data-structure-overview
- SDK reference (verified field-value shapes): https://github.com/larksuite/oapi-sdk-go
