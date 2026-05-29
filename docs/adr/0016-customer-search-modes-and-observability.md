# Customer Search modes — flag-gated server-indexed path + first-class observability

> **Status: accepted.** Extends [ADR-0013](0013-customer-directory-preload-and-picker.md). Keeps the preload + in-memory directory as the **default**; adds a second, build-flagged path that mirrors the Customer Table into a Convex `customers` table with a Convex **search index**, eliminating the per-login preload. Adds explicit observability milestones (Sentry + the Convex dashboard) for the customer-flow and Outlook-add-in boot.

[ADR-0013] picked preload because Base's `/records/search` is a per-field `contains` filter with no ranking — server-side typeahead would be *slow and bad-quality*. That trade is true at the current ~250-row scale. It is **not** what production CRM search looks like in 2026 (Linear, Notion, HubSpot, etc. all use a dedicated search index with server-side ranking and live data). At 5000+ rows the preload approach hits real ceilings: privacy (entire CRM ships to every browser), staleness (session-bound), payload (~120 KB gzipped), no relevance ranking. This ADR records both paths and lets a single env flag pick between them.

## Decision

- **Two paths, one flag.** A build-time env var `VITE_CUSTOMER_SEARCH_MODE` selects the active path:
  - `"preload"` (default, unset → preload): keeps the [ADR-0013] behaviour exactly.
  - `"server-index"`: skips the preload; per-keystroke debounced Convex queries hit a Convex search index over a mirrored `customers` table.
- **The server-indexed path's data layer:**
  - A new Convex table `customers` (mirror of the Feishu Customer Table) — schema mirrors the `CustomerRecord` projection plus a `searchBlob` text field for the index.
  - A Convex **search index** `by_text` on `searchBlob` (Convex's `withSearchIndex` — ranked, prefix-aware).
  - A Convex **internal mutation** `customersMirror.applyPage` that upserts a batch into `customers` keyed by `recordId`. Uses `ctx.db.patch` on existing rows and `ctx.db.insert` on new ones, so a Customer's local `_id` is stable across mirror runs.
  - A Convex **action** `customersMirror.fullSync` that pages Base with Feishu's supported `records/search` API (not historical `records/list`) → calls `applyPage` per page → records `mirroredAt` plus audit counters in a small `customersMirrorState` row. Tenant-token; read-only against Base (HARD RULE preserved).
  - A **weekly cron** (`crons.interval("customers mirror refresh (weekly)", { hours: 168 }, internal.feishu.customersMirror.fullSync, {})`) refreshes the mirror in the background. On-demand kicks: a public action `customersMirror.kick` lets the SPA force a refresh from the picker.
  - A public **query** `customers.search({ q, mineFor? })` runs `q.search("searchBlob", q)` and optionally `.eq("ownerOpenId", mineFor)` (the "Show mine" filter from the search panel). Returns top-20 ranked.
- **The SPA hook (`useCustomerSearch`) is mode-aware:**
  - `preload`: identical to today — `useCustomerDirectory` + local `Array.filter` + server-side `searchCustomers` action fallback.
  - `server-index`: no preload; per-keystroke **cache-aside-with-lazy-fill** against the Convex mirror:
    1. `convex.query(api.customersMirror.search, { q })` — fast hit path (~30-80 ms).
    2. If 0 hits → `convex.action(api.customersMirror.searchAndCacheMiss, { q })` — live Feishu `/records/search` (slower, 200-500 ms cross-border), maps the hits, **incrementally upserts** them into the mirror keyed by `recordId`, returns the hits.
    3. Future searches for the same query (or anything that touches those rows) hit the mirror cache.
  - **Why this is state-of-the-art for the weekly-update model:** the weekly cron is the *background* reconcile; cache-miss is the *on-demand* reconcile. The mirror gradually warms with whatever the salesperson actually searches for, and the user's stated assumption — "the Customer list doesn't change very often" — is exactly what makes the cache hot-rate high. No row is ever fetched twice unless it changes.
- **Observability is first-class — not an afterthought.** Every customer-search and customer-pick step emits structured timing via `dlog`/`dtime` → DebugPanel + F12 console + Sentry breadcrumb. Convex actions log the same metrics on the server side (visible in `convex logs` and the Convex dashboard). The Outlook-add-in boot phase gets a dedicated `Feishu SPA ready` milestone marking the moment `Office.context.mailbox` is reachable AND the auth session has resolved — the user-visible "I clicked the button → I can sync" interval.

### Observability milestones (canonical set)

| Milestone | Where it fires | Format on DebugPanel + F12 |
|---|---|---|
| `boot (HTML+JS loaded, app start)` | `initDebug()` at module load | `⏱ … : Xms since pane load` |
| `office: requirement set probed, host=Outlook` | `useOffice` when Office.js init resolves | `dload` line |
| `feishu auth resolved (loggedIn=true)` | `useFeishuAuth` first non-loading state | `dload` line |
| `Feishu SPA ready` | First render where Office is ready AND auth is resolved | `⏱ Feishu SPA ready: Xms since pane load` |
| `customer directory: preload starting / ready / SLOW / FAILED` | `useCustomerDirectory` (preload mode only) | as today |
| `customer search (server) "<q>" → N` | per-keystroke server fallback / server-index mode query | `⏱ … : Xms` |
| `customer picker: search opened / closed / local filter / picked` | `CustomerPicker` interactions | as today |

These all flow through one pipeline: `dlog` → `dtime` → buffer (DebugPanel, Ctrl+Alt+D) → F12 console → Sentry breadcrumbs. The Sentry `tracesSampleRate: 1` already captures every navigation/pageload + every fetch/xhr automatically, so on top of breadcrumbs we get full waterfall spans.

## Why both paths instead of just one

- **The preload approach was fit at the original small-table scale.** Once the Customer Table grew to ~14k rows, preload became structurally wrong for privacy and payload size.
- **The server-indexed path is the long-term answer.** It avoids shipping the whole CRM directory to each browser and makes search quality a backend concern. Having the upgrade path built and flag-toggleable means the migration is a deploy-config change, not a code change under pressure.
- **A flag, not a fork.** Both paths share the SPA hook surface (`useCustomerSearch`) and the same `CustomerRecord` projection. The CustomerPicker is unchanged. Only the data-source layer swaps.

## Why the search index lives in Convex (not Algolia/Typesense/Meilisearch)

- Convex already has a search-index primitive — `defineTable(...).searchIndex(name, { searchField, filterFields })` — that gives prefix + ranked relevance on a single text column. Same code path, same auth, same deploy. No new service to operate.
- The Customer Table is moderate scale (~14k rows as of 2026-05-29). A separate search service is still unnecessary for the current picker use case; Convex's search index covers the needed prefix/ranked lookup without adding another operational system.
- One backend, one set of tests, one place to look on the Convex dashboard for metrics. The user explicitly asked the monitoring live in Convex.dev — this keeps it there.

## Consequences

- **New Convex tables and a cron.** The schema gains `customers` (mirror) and `customersMirrorState` (last-run watermark plus audit counters). The cron runs weekly; on-demand `kick` and cache-miss backfill refresh rows when users search.
- **Tenant-token reuse, no new scope.** Mirror uses the same `bitable:app` permission as everything else. No Feishu scope change, no user re-authorization.
- **HARD RULE intact.** Mirror only **reads** the Base Customer Table; it writes only to the Convex `customers` mirror table. Never modifies or creates a Base Customer row.
- **Staleness window** for the server-indexed path is the weekly cron interval unless the SPA triggers `kick` or a cache miss backfills matching rows.
- **Flag is build-time.** `VITE_CUSTOMER_SEARCH_MODE` is read from the SPA build; switching modes requires a redeploy. Acceptable — the choice is per-environment, not per-user.
- **No A/B per user in scope.** When/if A/B comparison is needed, this ADR is upgraded: the flag becomes a Convex `appConfig` row, the SPA reads it from a public query, and we can hash on user id. Not built today.

## Out of scope (future work)

- **Real-time mirror via Base webhooks.** Base does emit row-change events; subscribing them eliminates the 15-min staleness window. Requires the user to register a webhook receiver in Feishu's admin console + an HTTP route in Convex.
- **A `kick` SPA affordance.** A "refresh customers" button in the picker that calls `customersMirror.kick`. Wired but not exposed.
- **Frecency-ranked recents.** LRU of last 20 picks in localStorage, surfaced first regardless of mode. Skipped this iteration.
- **Cross-user A/B per session id.** Out of scope until A/B is needed.

## Amendment (2026-05-29) — mirror completeness incident + official Feishu limits

**Incident.** The real Feishu **Customer Table** had grown to ~14,000 rows, but the Convex mirror held only **10,246**. Root cause: `customersMirror.ts` carried an *our-own* `MAX_PAGES = 20` cap (20 x `PAGE_SIZE` 500 = 10,000). `runFullSync` broke the pagination loop at page 20 **silently**, even though Feishu pagination can continue with `has_more = true` and a `page_token`. Live Convex state showed the last full sync stamped **10,002** rows (10,000 capped source rows plus 2 dev fixtures in the dev deployment) and the remaining **244** mirror rows had older/newer `mirroredAt` buckets, consistent with non-full-sync backfill/history. Before this amendment, there was no per-row provenance audit to distinguish those 244 further.

**Official Feishu limits (open.feishu.cn only — the source of truth, no third-party wrapper, no guessed numbers):**
- `records/search` (POST) is the supported read path for this mirror: it can query existing records, returns at most **500** records per request, supports pagination via `page_token`, and returns `has_more` / `page_token`.
- `records/list` (GET) has the same 500-row pagination shape, but Feishu marks it as a historical interface and recommends `records/search` instead. Do not switch the mirror to `records/list`.
- Both record endpoints document a **20 requests/sec** rate limit. The mirror paces page requests at least 60 ms apart to stay below that limit.
- The `records/list` error table documents single-table `RecordExceedLimit` at **20,000** records; treat that as a Feishu table-limit signal, not as a reason to add a local `MAX_PAGES` cap.

Doc URLs: `/document/server-docs/docs/bitable-v1/app-table-record/search`, `/document/server-docs/docs/bitable-v1/app-table-record/list`, `/document/server-docs/api-call-guide/frequency-control`.

**Fix (shipped in working tree).**
- Removed the `MAX_PAGES` cap; `runFullSync` now pages until `has_more = false`, pacing requests at least 60 ms apart (about 16/sec) to stay under the documented 20 QPS limit.
- Broken pagination is no longer silent: if Feishu returns `has_more = true` without a fresh `page_token` (or repeats one), the run records `lastStopReason` (`missingPageToken` / `duplicatePageToken`) and **throws**, so a short run shows up as a *failed* cron run instead of a quiet truncation.
- Audit watermark: `customersMirrorState` gains `lastPageCount`, `lastPageSize`, `lastInsertedCount`, `lastUpdatedCount`, `lastDuplicateCount`, `lastHadMore`, `lastStopReason`, `lastDurationMs`, `lastFinishedAt`, `lastSourceTableId` (all optional, widened in place so the existing deployment row keeps validating). Per-page and per-run lines log to `convex logs` for audit / monitor / review.

**Follow-up hardening (this session).**
- **Completeness audit via Feishu `total`.** Every `records/search` page returns `total` (总记录数) — the authoritative source count. `runFullSync` now captures it (`lastReportedTotal`) alongside the source rows actually paged (`lastSourceRowCount`, excluding dev fixtures). If pagination ends cleanly but rows-seen < `total`, the run records `lastStopReason = "incompleteTotal"` and **throws**, so a silent shortfall is impossible — this is the completeness signal independent of our own page counters.
- **Dev fixtures gated to dev only.** `isDevCustomerFixturesEnabled()` previously matched any deployment id *containing* `steady-setter-706`, so prod (`prod:steady-setter-706`) injected 2 dev fixtures (incl. `fenchem.com → fanpc`) into the prod mirror — the +2 in the 10,002 watermark. The substring clause was removed; fixtures now require a `dev:`-prefixed deployment or `ENABLE_DEV_CUSTOMER_FIXTURES=true`.

**Cron correction.** The mirror cron is **weekly** (`crons.ts`, 168 h), not the 15-min interval this ADR's body (and the old schema comment) stated. On-demand `kick` + cache-miss backfill cover freshness between weekly ticks.

## References

- Convex search indexes: https://docs.convex.dev/database/text-search
- Convex crons: https://docs.convex.dev/scheduling/cron-jobs
- Feishu /records/search (pagination + filter contract): https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/search
- Sentry breadcrumbs + browser tracing: https://docs.sentry.io/platforms/javascript/configuration/integrations/browsertracing/
- [ADR-0013](0013-customer-directory-preload-and-picker.md) — preload-mode origin
- [ADR-0015](0015-m365-office-js-official-sources.md) — boot-time Office.js surface (where the "Feishu SPA ready" milestone fires)
