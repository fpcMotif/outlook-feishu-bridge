# Customer Mirror prune (tombstone) + real-time Feishu event sync

> **Status: accepted.** Extends [ADR-0016](0016-customer-search-modes-and-observability.md). Adds (1) a **Mirror Prune** that deletes Convex `customers` rows no longer present in the Feishu **Customer Table**, fixing an unbounded overcount, and (2) a **Feishu Event Subscription** webhook that propagates record changes to the mirror in real time. Also records the incident where the prune fix ran in **production but existed in no git ref**.

## Incident — the mirror drifted to 2-5× the source

The Convex **Customer Mirror** (`convex/feishu/customersMirror.ts`) is an upsert read model keyed by Bitable `recordId`. ADR-0016 fixed *under*count (a local `MAX_PAGES` cap) and a dev-fixture leak, but a worse failure was latent: the mirror **only ever inserted/updated — it had no delete path anywhere**. So when a **Customer** was deleted in Feishu, or the Customer Table was re-imported (which mints fresh `record_id`s for the same logical rows), or rows were bulk-migrated, the old Convex rows became **orphans that lived forever**. Over months the mirror grew to ~30,000-50,000 rows against a live **Customer Table** of `<15,000` — a 2-5× overcount that inflates search-index cost and surfaces stale/deleted Customers in the picker.

A compounding flaw: `applyPage` returns `"unchanged"` **without re-stamping `mirroredAt`**, so there was no per-row liveness signal — the mirror could not even *detect* orphans by "last seen", let alone prune them.

### Why it was invisible: the fix lived only in production

Diagnosing on `prod:steady-setter-706` (read-only) showed the mirror was actually **healthy** — 14,228 rows, 0 duplicates, aligned with Feishu's reported `total` of 14,226, with watermark fields `lastPruneScannedCount`/`lastDeletedStaleCount` and deployed functions `listRowsForPrune` + `deleteRowsById`. **None of that prune code existed in `main` or any git ref** (pickaxe across all refs for `lastDeletedStaleCount` / `listRowsForPrune` returned nothing). Production had been deployed from an **uncommitted working tree**: the fix worked live but was absent from version control, so **any redeploy from `main` would silently reintroduce the overcount.** This ADR re-establishes the fix in the durable codebase.

## Decision

### Mirror Prune (tombstone), gated on a verified-complete sync

- **Liveness by in-run seen-set, not by timestamp.** A **Mirror Refresh** (`runFullSync`) accumulates the set of every `recordId` it writes this run — both the rows paged from the **Customer Table** and any dev fixtures applied. (This sidesteps the `mirroredAt`-not-re-stamped flaw: liveness is "seen in *this* run", not "recently stamped".)
- **Prune scan.** After paging, an internal query `listRowsForPrune(paginationOpts)` pages the whole `customers` table returning only `{_id, recordId}`; an internal mutation `deleteRowsById({ids})` tombstones a bounded batch. The action drives the loop (Convex's documented bulk-delete pattern — actions read via `runQuery`, write via `runMutation`, one batch per mutation to stay under the per-transaction write budget). Counts roll into the **Mirror Watermark** as `lastPruneScannedCount` / `lastDeletedStaleCount`.
- **HARD SAFETY GATE (`shouldPruneStaleRows`): prune runs *only* when the final stop reason is `complete`** — i.e. Feishu reported `has_more = false` **and** paged rows ≥ Feishu's `total` (the existing completeness check). A `missingPageToken` / `duplicatePageToken` / `incompleteTotal` run prunes **nothing**. This is the load-bearing invariant: without it, a transient Feishu error or a truncated page walk would delete live rows and wipe the mirror. Unit tests lock both directions (orphans deleted on a complete sync; *zero* deletes — the scan never even runs — on an incomplete sync).
- **Dev fixtures are protected**: their `recordId`s are added to the seen-set when applied, so the prune never tombstones them in dev.
- The prune is purely additive to ADR-0016: the same weekly cron and **Mirror Kick** drive it; `searchAndCacheMiss` is unchanged.

### Real-time event sync (replaces full-repage polling for freshness)

The weekly **Mirror Refresh** + prune is the completeness *floor*, but it leaves a staleness window (and a `kick` re-pages all ~29 pages). Per Feishu best practice — *"to track data changes in real time, use Event Subscriptions (事件订阅)"* — a webhook now propagates changes incrementally:

- **Endpoint** `POST /feishu/events` ([convex/http.ts](../../convex/http.ts)) receives the Bitable record-change event, answers the `url_verification` challenge, verifies the `X-Lark-Signature`, decrypts the Encrypt-Key envelope, and — for changes to the **Customer Table** — schedules per-record mirror work, returning HTTP 200 inside Feishu's 3 s window.
- **`record_deleted` → instant tombstone** (`deleteByRecordId`). This is the direct fix for the overcount root cause: deletes propagate immediately instead of waiting for the weekly prune.
- **`record_added` / `record_edited` → `refreshRecordById`**: re-read that one record from Feishu (the event carries only `field_id` diffs, not named fields) and upsert. Non-fatal on failure — the weekly Refresh + prune reconciles.
- Pure parsing/crypto (`convex/feishu/recordChangedEvent.ts`) uses **Web Crypto only** (Convex runtime has no Node `crypto`) and is fully unit-tested (handshake, signature, AES-256-CBC round-trip, change extraction).

### Corrections to the architectural audit (official sources only)

The audit that prompted this work contained fabricated/transposed facts; verified against official Feishu/Lark docs + the official SDKs (node-sdk, oapi-sdk-python, oapi-sdk-go):

- **Event name.** The audit's `bitable.ui.record.updated_v1` is **fabricated** (zero matches in any official doc or SDK). `contact.user.updated_v3` is real but is the **directory employee-change** event, unrelated to Bitable. The single real event for record create/update/delete is **`drive.file.bitable_record_changed_v1`**, disambiguated per record by `action_list[].action` ∈ {`record_added`, `record_edited`, `record_deleted`}.
- **Rate limits.** The audit's "50 QPS standard / 5 QPS Bitable" is unsupported. Limits are **per-API × per-app × per-tenant** tiers; the Bitable record read family (`records/search` POST, `records/list` GET, `records/batch_get`) is **20 requests/sec**, ≤500 rows/page — matching ADR-0016. Over-limit → HTTP 429, code `99991400`.
- **`requestSync.ts` is NOT polling.** The audit told us to "delete the polling loops in `requestSync.ts`"; that file is the **intake outbox reconcile** ([ADR-0018](0018-request-sync-outbox-and-reconcile.md)), not customer-mirror polling. It was left intact.
- **Scope.** Subscribing to the event needs `bitable:app` — already held by the mirror; no new authorization.

### Identity key (RC2) — kept, documented, monitored

The mirror keys on `recordIdFromCustomerInfoRow`, which reads the user-facing `Record Id` **column** and falls back to the immutable API `record_id`. The canonical identity is the API `record_id`; the column is expected to be a `RECORD_ID()` formula (prod rows are all `rec…`-format, confirming this today). Keying on a user column is a latent fragility — if that column ever became a manual/non-formula field, rows would re-key and the prune would tombstone the stale keys (an acceptable self-heal, but disruptive). We did **not** change the key in this ADR, to avoid coupling a risky re-key migration to the critical prune fix. Flagged as a follow-up.

## Consequences

- **Schema.** `customersMirrorState` gains optional `lastPruneScannedCount` / `lastDeletedStaleCount` (widened in place; existing rows still validate). Two new internal functions (`listRowsForPrune`, `deleteRowsById`) and two webhook-driven functions (`deleteByRecordId`, `refreshRecordById`).
- **Self-correcting.** The first complete Refresh after deploy tombstones the accumulated orphans; the mirror converges to the live Customer Table count and the webhook keeps it there between syncs.
- **Operator setup (required for the webhook).** Set Convex env vars `FEISHU_EVENT_ENCRYPT_KEY` and `FEISHU_EVENT_VERIFICATION_TOKEN`, then register the request URL `https://<deployment>.convex.site/feishu/events` in the Feishu console and subscribe to `drive.file.bitable_record_changed_v1`. Until configured, the weekly Refresh + prune remains the freshness mechanism (the endpoint rejects unsigned requests when an Encrypt Key is set).
- **HARD RULE intact.** Prune and webhook only ever **read** Bitable and **write** the Convex mirror; the Customer Table is never modified.
- **Process.** Production must be deployed from a committed git ref (CI / `convex deploy` from `main`), never an ad-hoc working tree — that is how the prior prune fix went missing.

## References

- Feishu Bitable record-change event: https://open.feishu.cn/document/docs/bitable-v1/events/bitable_record_changed
- Feishu event list (drive-v1, action enum): https://open.feishu.cn/document/server-docs/docs/drive-v1/event/list/bitable-record-changed
- URL-verification challenge: https://open.larksuite.com/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/request-url-configuration-case
- Encrypt Key (AES-256-CBC) + signature: https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case
- Feishu frequency control (per-API × per-app × per-tenant, 20 QPS Bitable read): https://open.feishu.cn/document/server-docs/api-call-guide/frequency-control
- Feishu get single record: https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/get
- Convex pagination: https://docs.convex.dev/database/pagination
- Convex bulk delete from actions + transaction limits: https://docs.convex.dev/production/state/limits
- [ADR-0016](0016-customer-search-modes-and-observability.md) — Customer Mirror + server-index search
- [ADR-0018](0018-request-sync-outbox-and-reconcile.md) — the intake outbox reconcile the audit mis-identified as polling
