# Customer Search modes — flag-gated server-indexed path + first-class observability

> **Status: accepted.** Extends [ADR-0013](0013-customer-directory-preload-and-picker.md). Keeps the preload + in-memory directory as the **default**; adds a second, build-flagged path that mirrors the Customer Table into a Convex `customers` table with a Convex **search index**, eliminating the per-login preload. Adds explicit observability milestones (Sentry + the Convex dashboard) for the customer-flow and Outlook-add-in boot.

[ADR-0013] picked preload because Bitable's `/records/search` is a per-field `contains` filter with no ranking — server-side typeahead would be *slow and bad-quality*. That trade is true at the current ~250-row scale. It is **not** what production CRM search looks like in 2026 (Linear, Notion, HubSpot, etc. all use a dedicated search index with server-side ranking and live data). At 5000+ rows the preload approach hits real ceilings: privacy (entire CRM ships to every browser), staleness (session-bound), payload (~120 KB gzipped), no relevance ranking. This ADR records both paths and lets a single env flag pick between them.

## Decision

- **Two paths, one flag.** A build-time env var `VITE_CUSTOMER_SEARCH_MODE` selects the active path:
  - `"preload"` (default, unset → preload): keeps the [ADR-0013] behaviour exactly.
  - `"server-index"`: skips the preload; per-keystroke debounced Convex queries hit a Convex search index over a mirrored `customers` table.
- **The server-indexed path's data layer:**
  - A new Convex table `customers` (mirror of the Feishu Customer Table) — schema mirrors the `CustomerRecord` projection plus a `searchBlob` text field for the index.
  - A Convex **search index** `by_text` on `searchBlob` (Convex's `withSearchIndex` — ranked, prefix-aware).
  - A Convex **internal mutation** `customersMirror.applyPage` that upserts a batch into `customers` keyed by `recordId`. Uses `ctx.db.patch` on existing rows and `ctx.db.insert` on new ones, so a Customer's local `_id` is stable across mirror runs.
  - A Convex **action** `customersMirror.fullSync` that pages Bitable → calls `applyPage` per page → records `mirroredAt` in a small `customersMirrorState` row. Tenant-token; read-only against Bitable (HARD RULE preserved).
  - A **cron** (`crons.interval("customers mirror", { minutes: 15 }, internal.feishu.customersMirror.fullSync, {})`) keeps the mirror within ~15 min of the source of truth. On-demand kicks: a public action `customersMirror.kick` lets the SPA force a refresh from the picker (future affordance; not exposed yet).
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

- **The preload approach is fit for today.** ~250 rows in single-tenant use — preload is fast, simple, and fully local. No reason to add WebSocket + index complexity *just yet*.
- **The server-indexed path is the long-term answer.** Once the table grows past ~5k rows or row-level security enters scope, preload fails for structural reasons (payload size, privacy leak). Having the upgrade path built and flag-toggleable means the migration is a deploy-config change, not a code change under pressure.
- **A flag, not a fork.** Both paths share the SPA hook surface (`useCustomerSearch`) and the same `CustomerRecord` projection. The CustomerPicker is unchanged. Only the data-source layer swaps.

## Why the search index lives in Convex (not Algolia/Typesense/Meilisearch)

- Convex already has a search-index primitive — `defineTable(...).searchIndex(name, { searchField, filterFields })` — that gives prefix + ranked relevance on a single text column. Same code path, same auth, same deploy. No new service to operate.
- The Customer Table is small (250-5000 rows). The full-text features of a dedicated search service are overkill; Convex's index covers the use case.
- One backend, one set of tests, one place to look on the Convex dashboard for metrics. The user explicitly asked the monitoring live in Convex.dev — this keeps it there.

## Consequences

- **New Convex tables and a cron.** The schema gains `customers` (mirror) and `customersMirrorState` (last-run watermark). The cron runs every 15 min; one extra Convex deployment per code change.
- **Tenant-token reuse, no new scope.** Mirror uses the same `bitable:app` permission as everything else. No Feishu scope change, no user re-authorization.
- **HARD RULE intact.** Mirror only **reads** the Bitable Customer Table; it writes only to the Convex `customers` mirror table. Never modifies or creates a Bitable Customer row.
- **Staleness window** for the server-indexed path is the cron interval (15 min by default). A Customer added in Bitable will appear in search after the next mirror tick. For tighter freshness, the `kick` action lets the SPA trigger an immediate refresh (deferred until the UI calls for it).
- **Flag is build-time.** `VITE_CUSTOMER_SEARCH_MODE` is read from the SPA build; switching modes requires a redeploy. Acceptable — the choice is per-environment, not per-user.
- **No A/B per user in scope.** When/if A/B comparison is needed, this ADR is upgraded: the flag becomes a Convex `appConfig` row, the SPA reads it from a public query, and we can hash on user id. Not built today.

## Out of scope (future work)

- **Real-time mirror via Bitable webhooks.** Bitable does emit row-change events; subscribing them eliminates the 15-min staleness window. Requires the user to register a webhook receiver in Feishu's admin console + an HTTP route in Convex.
- **A `kick` SPA affordance.** A "refresh customers" button in the picker that calls `customersMirror.kick`. Wired but not exposed.
- **Frecency-ranked recents.** LRU of last 20 picks in localStorage, surfaced first regardless of mode. Skipped this iteration.
- **Cross-user A/B per session id.** Out of scope until A/B is needed.

## References

- Convex search indexes: https://docs.convex.dev/database/text-search
- Convex crons: https://docs.convex.dev/scheduling/cron-jobs
- Feishu /records/search (pagination + filter contract): https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/search
- Sentry breadcrumbs + browser tracing: https://docs.sentry.io/platforms/javascript/configuration/integrations/browsertracing/
- [ADR-0013](0013-customer-directory-preload-and-picker.md) — preload-mode origin
- [ADR-0015](0015-m365-office-js-official-sources.md) — boot-time Office.js surface (where the "Feishu SPA ready" milestone fires)
