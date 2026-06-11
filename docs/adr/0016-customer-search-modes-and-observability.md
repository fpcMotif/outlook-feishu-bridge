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
- Audit watermark: `customersMirrorState` gains `lastPageCount`, `lastPageSize`, `lastInsertedCount`, `lastUpdatedCount`, `lastUnchangedCount`, `lastDuplicateCount`, `lastHadMore`, `lastStopReason`, `lastDurationMs`, `lastFinishedAt`, `lastSourceTableId` (all optional, widened in place so the existing deployment row keeps validating). Per-page and per-run lines log to `convex logs` for audit / monitor / review.

**Follow-up hardening (this session).**
- **Completeness audit via Feishu `total`.** Every `records/search` page returns `total` (总记录数) — the authoritative source count. `runFullSync` now captures it (`lastReportedTotal`) alongside the source rows actually paged (`lastSourceRowCount`, excluding dev fixtures). If pagination ends cleanly but rows-seen < `total`, the run records `lastStopReason = "incompleteTotal"` and **throws**, so a silent shortfall is impossible — this is the completeness signal independent of our own page counters.
- **No-op write suppression.** Weekly full refreshes compare the projected Customer row (`recordId`, display fields, owner fields, and `searchBlob`) before patching the Convex mirror. Unchanged rows now return `unchanged` instead of calling `ctx.db.patch`, reducing avoidable Convex invalidation/search-index rewrite work while keeping Feishu as source of truth for changed or inserted rows. The watermark records this as `lastUnchangedCount`.
- **On-search refresh throttling.** The SPA trigger for `customersMirror.kick` is throttled to once per taskpane session every 15 minutes. This avoids stacking multiple full mirror refresh actions when users repeatedly open the picker; cache-miss backfill remains the per-query freshness path.
- **Short-query guard.** The CustomerPicker, server-index search adapter, public mirror search query, and cache-miss action do not call search-index/server/Feishu fallback for one-character queries. Local directory matches still render immediately, one-character no-match input does not open an empty/create dropdown, and server search starts at two characters to avoid broad, low-quality cache-miss traffic. Repeated empty live misses are suppressed briefly at the adapter boundary while still rechecking the Convex mirror first.
- **Smaller interactive cache-miss pages.** Full mirror sync still uses Feishu's documented max `page_size=500`, but `searchAndCacheMiss` uses `page_size=50` and the same `field_names` projection as full sync. The picker returns at most 50 records, so cache misses no longer pull/upsert 500 rows or receive unneeded Bitable fields on an interactive keystroke.
- **Dev fixtures gated to dev only.** `isDevCustomerFixturesEnabled()` previously matched any deployment id *containing* `steady-setter-706`, so prod (`prod:steady-setter-706`) injected 2 dev fixtures (incl. `fenchem.com → fanpc`) into the prod mirror — the +2 in the 10,002 watermark. The substring clause was removed; fixtures now require a `dev:`-prefixed deployment or `ENABLE_DEV_CUSTOMER_FIXTURES=true`.

**Cron correction.** The mirror cron is **weekly** (`crons.ts`, 168 h), not the 15-min interval this ADR's body (and the old schema comment) stated. On-demand `kick` + cache-miss backfill cover freshness between weekly ticks.

## Amendment (2026-06-01) — Mirror Kick rate-limit moves server-side

**Incident.** `convex logs --history` showed `customersMirror:kick` running a full ~29-page (~14.5k-row) re-page of the Customer Table and **restarting every ~2 s**. Root cause: the "on-search refresh throttling" above (the 15-min cooldown) was held in **frontend module state** (`lastMirrorKickStartedAt` in `useCustomerSearchServerIndex.ts`). That state resets on every taskpane reload and is not shared across tabs, so reloads/HMR/multiple panes each restart the cooldown at zero — it cannot throttle a **shared** resource. `kick` itself had no server-side guard and called `runFullSync` unconditionally.

**Decision — the cooldown is authoritative on the server, and it is global.**
- The **Mirror Kick** (the canonical name for the on-demand trigger — see CONTEXT.md) claims a single shared "last refresh started" timestamp on the existing `customersMirrorState` row and **returns early without paging Feishu** if a full refresh started within the cooldown window.
- **Global, not per-user.** The **Customer Mirror** is a single shared read model and a **Mirror Refresh** re-pages the *entire* Customer Table regardless of who triggered it — so the cost and the freshness benefit are both global. A per-user cooldown would let N salespeople each trigger a full global re-page for identical shared benefit.
- **Any full refresh stamps the timestamp; only the kick gates on it.** Both the weekly cron (`fullSync`) and an on-demand `kick` record "last refresh started"; only `kick` checks it. The **weekly cron always runs unconditionally** — it is the guaranteed freshness floor and must never skip. (So a kick fired minutes after the weekly cron correctly no-ops and the user still gets the just-rebuilt mirror.)
- The frontend module-level cooldown may stay as a cheap first gate, but it is **advisory**; correctness lives on the server.

**Follow-up trace (2026-06-01) - the server gate must be atomic.** The first server-side cooldown still had a race: `kick` read `lastRefreshStartedAt` in an internal query, then `runFullSync` stamped the row in a later mutation. Two taskpanes/reloads that reached the read before either stamp became durable could both start a full ~29-page refresh. `kick` now calls `startRefreshIfAllowed`, a single internal mutation that reads the prior timestamp and writes the new one in the same Convex transaction; the winning kick runs `runFullSync` with `markStarted: false`, and racing kicks return a structural no-op. `convex/feishu/customersMirror.test.ts` locks this by racing two kicks and asserting only one Feishu page request path starts.

**Rejected — `reportedTotal`-unchanged short-circuit.** Skipping the re-page when Feishu reports the same `total` would miss **same-count in-place edits** (e.g. a corrected `域名`), leaving the mirror — and email auto-match — stale until the weekly cron. `applyPage`'s change-detection already makes the *write* cost near-zero, and the cooldown already bounds the *read* cost; a total-based skip trades correctness for marginal savings. Not adopted.

**HARD RULE intact.** The rate-limit timestamp and every mirror write stay in Convex (`customersMirrorState` / `customers`); the **Customer Table** in Bitable is only ever read, never written.

## Amendment (2026-06-01) — CJK character-bigram tokenization (split-value search)

**Incident.** A salesperson typing a natural multi-character Chinese query — e.g. the substring `上海化妆品` against `中云(上海)化妆品有限公司` — got **zero** mirror hits and then waited on the live Feishu fallback, which *also* returned 0 (the literal `)` between `上海` and `化妆品` breaks the `contains` substring), so the keystroke cost **mirror round-trip + ~2.7 s live → nothing** — slower than a direct Feishu call and useless. `convex logs` confirmed the live `searchAndCacheMiss` server time (~1.5–2.7 s) on top of the silent mirror miss.

**Root cause (grounded in the Convex contract).** Convex's search index tokenizes with Tantivy's **SimpleTokenizer**, which "splits on whitespace and punctuation" and prefix-matches only the **final** term (docs.convex.dev/search/text-search — "works best with English or other Latin-script languages"). Chinese has no inter-word spaces, so each CJK run is indexed as **one token**: `中云(上海)化妆品有限公司` → `中云` / `上海` / `化妆品有限公司`. A query that spans a punctuation/word boundary (`上海化妆品`) is itself one token that prefix-matches none of them → 0 hits. Live probes quantified the gap: `化妆品` returned **2** mirror hits vs **50** from Feishu `contains`.

**Fix — character-bigram indexing (`convex/feishu/cjkSearch.ts`).** The standard remedy for a whitespace tokenizer over CJK (Lucene's `CJKBigramFilter`, Elasticsearch's CJK analyzer): index every overlapping 2-character window of the CJK text so a substring query becomes an ordinary term match.
- `buildSearchBlob` appends per-field CJK bigrams after the plain concatenation, stripping intra-field non-CJK first so a bigram **bridges** separators like `(上海)` (→ `… 上海 海化 化妆 妆品 …`). Latin/digit tokens are untouched and keep prefix matching.
- The public `search` query bigram-expands the **query** the same way (`toSearchQueryString`) before `withSearchIndex`, capped at Convex's documented **16-term** ceiling. An all-punctuation query collapses to `""` and is treated as a miss.
- Self-healing: `searchAndCacheMiss` backfill and the weekly `fullSync` both write through `buildSearchBlob`, so rows pick up bigrams as they are re-synced. **A one-time `fullSync` after deploy rebuilds every blob** (change-detection marks them `updated`); until then, un-resynced rows keep the old prefix-only behavior.

**Scope.** This changes the *server-index* path only (ADR-0016); the `preload` path (ADR-0013) is untouched. HARD RULE intact — bigrams live in the Convex `customers` mirror; Bitable is still read-only.

## Amendment (2026-06-11) — Customer search stack hardening

### Fixes

**Fix 3 — `applyPage` clear-path bug (undefined-strip across action→mutation boundary).**
When a Feishu Bitable cell is cleared, the Feishu API simply omits that field from the row object (`domain`, `domainKey`, etc. become `undefined` in the TypeScript projection). Convex serialises `undefined` values silently when an action calls `ctx.runMutation` — the field is *dropped from the wire encoding* and the mutation never sees it. The old `applyPage` spread (`{ ...row, mirroredAt }`) therefore left the stale column value in place rather than clearing it. Fix: the spread now leads with explicit-`undefined` fallbacks before the row, so any absent optional field produces `domain: undefined` in the patch — which Convex's `db.patch` semantics interpret as "remove this field".

**Fix 5 — Per-domain server-side cooldown for `matchEmailAndCacheMiss`.**
Each live Feishu domain probe (`matchEmailAndCacheMiss`) now acquires a **per-domain** cooldown slot before touching Feishu. The pattern follows `startRefreshIfAllowed` (ADR-0016 § Mirror Kick): an internal mutation `startDomainMatchIfAllowed` reads and writes the cooldown timestamp atomically in one Convex transaction. A new schema table `customerDomainMatchCooldowns` (`by_domain` index) holds one row per probed domain. Cooldown window: **15 min** (same as the Mirror Kick, so a domain that fires a live probe doesn't re-probe within the same 15-min refresh cycle). The client-side `EMPTY_DOMAIN_MATCH_TTL_MS` (5 min) is a UX-advisory layer on top; the server gate is authoritative.

**Fix 6.2 — `matchEmailAndCacheMiss` pagination (up to 3 pages).**
The domain `contains` filter can return superstring rows *before* the canonical match (e.g. `notacme.com` before `acme.com`). The action now loops up to `MAX_CACHE_MISS_PAGES = 3` pages of 50 rows each before giving up, accumulating all rows into a single `applyPage` call at the end. Early exit when a strict canonical match is found or `has_more = false`.

**Fix 6.1 — `liveAllowed: false` for negative-cache ordering.**
Previously, the SPA hook short-circuited the 30-second typed-search negative cache by returning `[]` before reaching the server. This prevented the mirror from being consulted — but `matchEmailAndCacheMiss` may have backfilled the mirror during the same session. The hook now passes `liveAllowed: false` to `searchCustomers`, so the **Customer-search engine** still consults the mirror (fast path, no cross-border cost) without triggering the live Feishu fallback. The engine's `liveAllowed` flag lives in `customerSearchEngine.ts` (ADR-0019 seam).

**Fix 6.3 — Remove client-side Mirror Kick from `triggerRefresh`.**
`triggerRefresh` in `useCustomerSearchServerIndex` is now a no-op `() => {}`. Rationale: the on-demand kick is rate-limited server-side (`startRefreshIfAllowed`, ADR-0016 §2026-06-01); the weekly cron is the freshness floor; cache-miss backfill handles the "new customer, open mail" case without a full re-sync. The thin client-side cooldown (`lastMirrorKickStartedAt`) was unreliable across tabs/reloads in any case (fixed by the 2026-06-01 server-side amendment) and is now removed entirely from the hook.

**Fix 6.4 — 150 ms debounce on typed Customer search.**
Each `search(q)` call in the server-index hook now returns a debounced Promise. Rapid keystrokes within 150 ms for the same normalised query key share a single pending timer; all callers' resolve functions are accumulated and fired together when the timer fires, collapsing multiple keystrokes into one server call. After the debounce fires, the existing in-flight coalescing (`inFlightSearches`) takes over for any further concurrent callers during the server round-trip.

**Fix 4 — Preload-mode `matchEmail` is document-only.**
`useCustomerSearchPreload.matchEmail` consults only the preloaded directory (`findCustomerByEmail`). A miss in preload mode is a genuine directory-absent case and does not warrant a live Feishu probe — the preload directory is already the full customer directory, so a miss means the customer does not exist in the directory. No change to implementation (was already document-only); this policy is now documented explicitly in the code comment and this ADR.

## References

- Convex search indexes: https://docs.convex.dev/database/text-search
- Convex crons: https://docs.convex.dev/scheduling/cron-jobs
- Feishu /records/search (pagination + filter contract): https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/search
- Sentry breadcrumbs + browser tracing: https://docs.sentry.io/platforms/javascript/configuration/integrations/browsertracing/
- [ADR-0013](0013-customer-directory-preload-and-picker.md) — preload-mode origin
- [ADR-0015](0015-m365-office-js-official-sources.md) — boot-time Office.js surface (where the "Feishu SPA ready" milestone fires)
