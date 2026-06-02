# Feishu Contacts Mirror — biweekly org-directory sync with server-indexed search

> **Status: accepted (code landed; live activation gated on a tenant contact-read scope + app release — see Dependencies).** Sibling of the Customer mirror ([ADR-0016](0016-customer-search-modes-and-observability.md) / [ADR-0021](0021-customer-mirror-prune-and-event-sync.md)); reuses its paginate → upsert → prune → watermark shape.

## Context

We already mirror the Feishu **Customer Table** into Convex on a cron so the SPA can run server-indexed search instead of paying a cross-border Feishu round-trip per keystroke. We now want the same for the Feishu **org directory** (internal employees), so colleagues are ranked-searchable by name / `@fenchem.com` email / department — for a future colleague picker and email-sender → colleague matching.

Requirements (from the request):

- Mirror the Feishu contact directory **biweekly**, assumed **≤ 800 entries**.
- Store **name**, **department**, **enterprise email** (`@fenchem.com`), **avatar**.
- **Never** store **personal email** or **phone numbers**.
- **Skip** resigned / exited employees.
- **Searchable** the same way customers are (CJK-aware search index).
- Orthogonal/additive — touch no existing customer/intake code paths.

## Decision

A new "contacts trio" mirroring the customer trio:

- `convex/feishu/contactsMirror.ts` — registered `internalAction fullSync` (the cron entry), the bounded `applyPage` / `deleteRowsById` / `listRowsForPrune` / `startRefreshIfAllowed` / `recordSyncCompletion` handlers, and a public `query search` (ranked `withSearchIndex` over `searchBlob`, CJK-expanded via `toSearchQueryString`).
- `convex/feishu/contactsMirrorSync.ts` — **pure** crawl state machine (per-walk stop-reason / next-token, department-name map, resigned filter, dedupe-by-openId, multi-walk completeness fold, ≤800 assumption check, prune helpers). Unit-tested.
- `convex/feishu/contactsMirrorRows.ts` — **pure** mapping (`FeishuContactUser` → row, `buildContactSearchBlob`, avatar fallback, dedupe). Unit-tested.
- `convex/schema.ts` — `feishuContacts` (keyed on the immutable `open_id`; `by_openId` + `by_email` indexes + `by_text` search index over `searchBlob`) and the `feishuContactsMirrorState` watermark.
- `convex/crons.ts` — `crons.interval(..., { hours: 336 }, internal.feishu.contactsMirror.fullSync, {})`.

**Enumeration.** The directory has **no "list all users" endpoint**, so the org is enumerated by crawling departments then listing each department's *direct* members:

1. Crawl all departments from the root with `fetch_child=true` (one recursive paginated walk) → `open_department_id → name` map.
2. For each id in `{"0" (root)} ∪ departments`, page `users/find_by_department` (direct members only). Standardize on `department_id_type=open_department_id` + `user_id_type=open_id` so user `department_ids` join to the map.
3. Filter `status.is_resigned || status.is_exited`; dedupe users by `open_id`.
4. Map → row: `email = enterprise_email` only (omit if blank — never personal `email`); `department` = joined department names; `avatarUrl` via the avatar-size fallback chain; `searchBlob` = name + email + department + per-field CJK bigrams.
5. Upsert in bounded batches keyed by `open_id`.

**Completeness + prune (same hard gate as ADR-0021).** `find_by_department` returns no global `total`, so a run is "complete" only when the department walk **and every** member walk reach `has_more=false` with no missing / duplicate `page_token`. The post-sync **prune** tombstones any mirror row whose `open_id` was not seen this run — gated strictly on a *complete* crawl, so a transient Feishu error or a truncated walk can never wipe live rows. Because `open_id` is stable, in steady state the prune removes exactly the leavers (and anyone newly resigned/exited, who are filtered out of the seen-set). A **single-flight lease** (`startRefreshIfAllowed`) stops a manual run and the cron from racing the prune's delete fan-out.

**Avatar is stored despite volatility.** [ADR-0003](0003-feishu-user-scopes-and-search-v1.md) found Feishu avatar URLs are time-bound and chose not to persist them for the coworker picker. Here storage is an explicit requirement; the biweekly run re-stamps the URL and any consumer must fall back to initials on a 404 (the URL is treated as a refreshable cache value, never as durable identity).

## Official sources (the only source of truth)

- Find users by department — `GET /open-apis/contact/v3/users/find_by_department` (direct members only; `page_size` ≤ 50; `page_token`/`has_more`; `department_id="0"` = root): https://open.feishu.cn/document/server-docs/contact-v3/user/find_by_department
- List a department's children — `GET /open-apis/contact/v3/departments/:department_id/children?fetch_child=true` (recursive descendants; `page_size` ≤ 50): https://open.feishu.cn/document/server-docs/contact-v3/department/children
- Contact v3 overview / scopes: https://open.feishu.cn/document/server-docs/contact-v3/resources
- SDK: github.com/larksuite/oapi-sdk-go

## Dependencies (BLOCKING for live activation)

The crawl uses the **tenant** token (the cron has no user session). The app today holds only tenant `bitable:app` ([ADR-0011](0011-feishu-permission-set.md)) and **cannot read the directory yet**. Before the cron returns data:

1. **Add a tenant contact-read scope** in the developer console (权限管理 → import JSON). Recommended: the broad read-as-app scope **`contact:contact:readonly_as_app`** (consistent with ADR-0011 choosing broad `bitable:app` over granular to avoid mid-config failures; it returns `enterprise_email` + `avatar`). We deliberately do **NOT** add `contact:user.phone:readonly` — phones are never read or stored.
2. **Release a new app version** (a scope change only takes effect after release). Because this is a **tenant**-identity scope, **no user re-authorization** is required (unlike the `contact:user:search` user scope).
3. **App data availability range (应用可用范围)** must cover the whole org, or the tenant read is silently bounded to a subset.

The first live run's log (`departments=… users=…`, plus populated `email`/`avatar`) confirms the scope actually unlocked `enterprise_email` + `avatar`; if a field is missing, add the matching field scope (`contact:user.email:readonly`).

## Consequences

- **A new tenant scope + app release are prerequisites** (above). Until then the cron throws / returns empty and the mirror stays unpopulated — no other path regresses.
- **`open_id` is the stable natural key**, so unlike the Bitable record-id mirror the contacts mirror does not churn keys on re-import; the prune mostly handles leavers and newly-resigned users.
- **Avatar URLs can expire between biweekly runs** — consumers must degrade to initials (no `onError` storage hack).
- **Deploy backend + frontend in lockstep**: this adds Convex schema + a cron, so push Convex from the same commit (the backend is one shared deployment).
- **`bun run test` (full SPA suite) is not part of this change's verification** — the pure modules are covered by their own `vitest run` files; the registered handlers are framework-wrapped (no `convex-test`, per [ADR-0018](0018-request-sync-outbox-and-reconcile.md) conventions) and verified by the live `fullSync` run.

## Alternatives rejected

- **Per-keystroke live `search/v1/user` only (no mirror).** That is the *coworker picker* path (user-token, [ADR-0003](0003-feishu-user-scopes-and-search-v1.md)); it pays a cross-border round-trip per query and cannot back an email-sender → colleague match. A mirror is the directory analogue of the customer mirror.
- **Store personal `email` / fall back to it.** Explicitly rejected — only the `@fenchem.com` enterprise mailbox is wanted.
- **Granular per-field contact scopes.** Least privilege, but (as with `bitable:app` in ADR-0011) risks a wrong-identifier batch-import failure; deferred to a hardening pass.
- **Skip the prune (upsert-only).** That is exactly the drift that bit the customer mirror (ADR-0021); leavers would linger forever.
