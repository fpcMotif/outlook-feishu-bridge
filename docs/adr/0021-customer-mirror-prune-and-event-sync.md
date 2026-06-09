# Customer Mirror prune (tombstone) + immutable key; real-time event sync deferred

> **Status: accepted.** Extends [ADR-0016](0016-customer-search-modes-and-observability.md). **Shipped:** (1) a **Mirror Prune** that deletes Convex `customers` rows no longer present in the Feishu **Customer Table**, fixing an unbounded overcount; (2) keying mirror identity on the **immutable API `record_id`** instead of the user-facing `Record Id` column; (3) **single-flight** on the full Mirror Refresh; (4) a **drift alarm** so an overcount can never recur silently. **Deferred (documented, not built):** a Feishu **Event Subscription** webhook for real-time change propagation — design + citations recorded below for when it is built.
>
> ADR number note: this decision was originally drafted as "ADR-0020" in code/PR comments, but `0020` was taken by [the selective-merge ADR](0020-selective-merge-pr25-build-intake-and-user-theme.md) on the `merge/pr25-build-intake-theme` branch. It is filed here as **0021**; references in code read `ADR-0021`.

## Incident — the mirror drifted to 2-5× the source

The Convex **Customer Mirror** (`convex/feishu/customersMirror.ts`) is an upsert read model keyed by Bitable `recordId`. [ADR-0016](0016-customer-search-modes-and-observability.md) fixed *under*count (a local `MAX_PAGES` cap) and a dev-fixture leak, but a worse failure was latent: the mirror **only ever inserted/updated — it had no delete path anywhere**. So when a **Customer** was deleted in Feishu, or the Customer Table was re-imported (which mints fresh `record_id`s for the same logical rows), or rows were bulk-migrated, the old Convex rows became **orphans that lived forever**. The mirror grew toward 2-5× the live **Customer Table** — an overcount that inflates search-index cost and surfaces stale/deleted Customers in the picker.

A compounding flaw: `applyPage` returns `"unchanged"` **without re-stamping `mirroredAt`**, so there was no per-row liveness signal — the mirror could not even *detect* orphans by "last seen", let alone prune them.

### Why it was invisible: the fix lived only on the deployed dev deployment

Diagnosing on the **dev deployment `steady-setter-706`** (read-only inspection) showed the mirror was actually **healthy** — 14,228 rows, 0 duplicate `record_id`s, aligned with Feishu's reported `total` of 14,226, with watermark fields `lastPruneScannedCount` / `lastDeletedStaleCount` and deployed functions `listRowsForPrune` + `deleteRowsById`. **None of that prune code existed in `main` or the `merge/pr25` branch** (pickaxe across all refs for `lastDeletedStaleCount` / `listRowsForPrune` returned nothing). The deployment had been pushed from an **uncommitted working tree**: the fix worked live but was absent from version control, so **any redeploy from `main` (which has the key fix but no prune) or a merge of `merge/pr25` (which had neither) would silently reintroduce the overcount.** This ADR re-establishes the full fix in the durable codebase.

## Decision

### 1. Mirror Prune (tombstone), gated on a verified-complete sync

- **Liveness by in-run seen-set, not by timestamp.** A **Mirror Refresh** (`runFullSync`) accumulates the set of every `recordId` it writes this run — both the rows paged from the **Customer Table** and any dev fixtures applied. (This sidesteps the `mirroredAt`-not-re-stamped flaw: liveness is "seen in *this* run", not "recently stamped".)
- **Prune scan.** After paging, an internal query `listRowsForPrune(paginationOpts)` pages the whole `customers` table returning only `{_id, recordId}`; an internal mutation `deleteRowsById({ids})` tombstones a bounded batch. The action drives the loop (Convex's documented bulk-delete pattern — actions read via `runQuery`, write via `runMutation`, one batch per mutation to stay under the per-transaction write budget). Counts roll into the **Mirror Watermark** as `lastPruneScannedCount` / `lastDeletedStaleCount`.
- **HARD SAFETY GATE (`shouldPruneStaleRows`): prune runs *only* when the final stop reason is `complete`** — i.e. Feishu reported `has_more = false` **and** paged rows ≥ Feishu's `total` (the existing completeness check). A `missingPageToken` / `duplicatePageToken` / `incompleteTotal` run prunes **nothing** (the scan never even runs). This is the load-bearing invariant: without it, a transient Feishu error or a truncated page walk would delete live rows and wipe the mirror. Unit tests lock both directions.
- **Dev fixtures are protected**: their `recordId`s are added to the seen-set when applied, so the prune never tombstones them in dev.

### 2. Immutable identity key (the re-key trigger, removed)

`mapFeishuItemToCustomer` previously keyed identity on `recordIdFromCustomerInfoRow` — the user-facing **`Record Id`** column, falling back to the API `record_id`. That column only equals the API id while it stays a `RECORD_ID()` formula; if it were ever switched to a manual/non-formula field, **every** mirror row would re-key and the prune would tombstone-and-reinsert the whole table on the next sync (a self-heal, but a disruptive churn and a second source of transient drift). Identity now keys on the **immutable Feishu API `item.record_id`** end-to-end (mapper → `projectionToRow` → `dedupeRowsByRecordId` → `by_recordId` upsert), and `matchClientRecordId` returns `record_id` directly so the Service-row Client DuplexLink target is immutable too. `recordIdFromCustomerInfoRow` is retained as a **display-only** reader and unit-tested as such.

### 3. Single-flight Mirror Refresh

The weekly cron `fullSync` was "on its own path and never gated", so it could run concurrently with an in-flight on-demand **Mirror Kick**. Two overlapping refreshes can race the prune's delete fan-out against the other run's inserts. Both entrypoints now acquire the **same** start lease via `startRefreshIfAllowed` (atomic check-and-set on `lastRefreshStartedAt`, lease = `MIRROR_REFRESH_LEASE_MS` = 15 min ≫ one ~45 s sync), so at most one full refresh runs at a time; the loser logs a skip and returns the no-op result.

### 4. Drift alarm

After a complete sync + prune, the retained mirror count (`pruneScanned − deletedStale`) should track Feishu's reported `total` (plus a couple of dev fixtures). `warnOnResidualDrift` logs a loud `DRIFT ALARM` via `console.error` when the retained count still exceeds the source total beyond a ratio (`DRIFT_ALARM_RATIO` = 5%) **and** an absolute floor (`DRIFT_ALARM_FLOOR` = 10). Pure observability — it never throws — so the overcount that caused the original 2-5× drift can never recur unseen.

## Deferred — real-time Feishu event sync (designed, not built)

The weekly **Mirror Refresh** + prune is the completeness *floor*, but it leaves a staleness window (and a `kick` re-pages all ~29 pages). The intended next step — **not implemented in this change** — is to track changes in real time via a Feishu **Event Subscription** (事件订阅): *"to track data changes in real time, developers should use Event Subscriptions."* This section records the verified design so it can be built later without re-doing the research.

**Shape.** A Convex `httpAction` at `POST /feishu/events` ([convex/http.ts](../../convex/http.ts)) would: answer the `url_verification` challenge, verify `X-Lark-Signature`, decrypt the Encrypt-Key envelope, and — for changes to the **Customer Table** — schedule per-record mirror work (`record_deleted` → instant tombstone by `recordId`; `record_added` / `record_edited` → re-read that one record from Feishu and upsert), returning HTTP 200 inside Feishu's 3 s window.

**Crypto must use Web Crypto** (`globalThis.crypto.subtle`) — the Convex runtime has no Node `crypto`. Sketch (verified against the official node-sdk):

```ts
// signature = SHA256_hex(timestamp + nonce + encryptKey + RAW body)
const expected = await sha256Hex(timestamp + nonce + encryptKey + rawBody); // hex of crypto.subtle.digest("SHA-256", …)
// envelope: key = SHA256(encryptKey) (32 bytes); buf = base64(encrypt); iv = buf[0:16]; ct = buf[16:]; AES-256-CBC
const key = await crypto.subtle.importKey("raw", keyDigest, { name: "AES-CBC" }, false, ["decrypt"]);
const plain = new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, ct));
// challenge: body {type:"url_verification", challenge, token} -> respond {challenge} within 1s
```

**Operator setup (when built).** Set Convex env `FEISHU_EVENT_ENCRYPT_KEY` + `FEISHU_EVENT_VERIFICATION_TOKEN`, register `https://<deployment>.convex.site/feishu/events` in the Feishu console, and subscribe to `drive.file.bitable_record_changed_v1`. Scope `bitable:app` (already held) suffices.

### Corrections to the architectural audit (official sources only)

The audit that prompted this work contained fabricated/transposed facts; verified against official Feishu/Lark docs + the official SDKs (node-sdk, oapi-sdk-python, oapi-sdk-go):

- **Event name.** The audit's `bitable.ui.record.updated_v1` is **fabricated** (zero matches in any official doc or SDK). The single real event for record create/update/delete is **`drive.file.bitable_record_changed_v1`**, disambiguated per record by `action_list[].action` ∈ {`record_added`, `record_edited`, `record_deleted`}; payload carries `event.table_id` + `event.file_token`.
- **Rate limits.** The Bitable record read family (`records/search` POST, `records/list` GET, `records/batch_get`) is **20 requests/sec**, ≤500 rows/page — matching ADR-0016. Over-limit → HTTP 429, code `99991400`.
- **`requestSync.ts` is NOT polling.** That file is the **intake outbox reconcile** ([ADR-0018](0018-request-sync-outbox-and-reconcile.md)), not customer-mirror polling. It was left intact.

## Consequences

- **Schema.** `customersMirrorState` gains optional `lastPruneScannedCount` / `lastDeletedStaleCount` (widened in place; existing rows still validate). Two new internal functions: `listRowsForPrune`, `deleteRowsById`.
- **Self-correcting.** The first complete Refresh after deploy tombstones the accumulated orphans; the mirror converges to the live Customer Table count.
- **Freshness between Refreshes** stays as ADR-0016 defines it (on-demand **Mirror Kick** + per-search cache-miss backfill) until the deferred event sync is built.
- **HARD RULE intact.** The prune only ever **reads** Bitable and **writes** the Convex mirror; the Customer Table is never modified (see [feedback: Bitable never touch existing rows]).
- **Process.** A deployment must be pushed from a committed git ref (CI / `convex deploy` from a branch), never an ad-hoc working tree — that is how the prior prune fix went missing.

## References

- Feishu Bitable record-change event: https://open.feishu.cn/document/docs/bitable-v1/events/bitable_record_changed
- Feishu event list (drive-v1, action enum): https://open.feishu.cn/document/server-docs/docs/drive-v1/event/list/bitable-record-changed
- URL-verification challenge: https://open.larksuite.com/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/request-url-configuration-case
- Encrypt Key (AES-256-CBC) + signature: https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case
- Feishu frequency control (per-API × per-app × per-tenant, 20 QPS Bitable read): https://open.feishu.cn/document/server-docs/api-call-guide/frequency-control
- Convex pagination: https://docs.convex.dev/database/pagination
- Convex bulk delete from actions + transaction limits: https://docs.convex.dev/production/state/limits
- [ADR-0016](0016-customer-search-modes-and-observability.md) — Customer Mirror + server-index search
- [ADR-0018](0018-request-sync-outbox-and-reconcile.md) — the intake outbox reconcile the audit mis-identified as polling
