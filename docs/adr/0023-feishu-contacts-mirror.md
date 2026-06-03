# Feishu Contacts Mirror — biweekly org-directory sync with server-indexed search

> **Status: accepted (code landed; a *base* contact-read scope is live, but the tenant **data range** still bounds the crawl to a subset — 8 users / 0 departments on 2026-06-03 — and the employee/department field scopes are not yet released. See Scopes + Dependencies).** Sibling of the Customer mirror ([ADR-0016](0016-customer-search-modes-and-observability.md) / [ADR-0021](0021-customer-mirror-prune-and-event-sync.md)); reuses its paginate → upsert → prune → watermark shape.

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
- **Scope/permission tables** (the `权限要求` block on each endpoint page above) — the field→scope mapping in the Scopes section below was read off these and verified **2026-06-03**.
- SDK: github.com/larksuite/oapi-sdk-go

## Scopes — exactly what, and why (least-privilege, verified against the docs)

The crawl runs on the **tenant** token (the cron has no user session), so every field it reads must be unlocked by a **tenant/app** scope *released* to the app. This is the trap to internalise: **user-token grants do nothing here.** The `auth login` device-flow scopes (`contact:user.base:readonly`, `contact:user:search`, etc., and the coworker picker of [ADR-0003](0003-feishu-user-scopes-and-search-v1.md)) authorise a *user* token; the cron never holds one. Granting them and expecting the mirror to fill is the most natural wrong turn — it changes nothing.

Two list endpoints are called. The official `权限要求` tables map each **field the mirror actually consumes** to the scope that unlocks it:

| Consumed by the mirror | Endpoint | Scope (verified at open.feishu.cn) |
|---|---|---|
| main access + user `name` / `avatar` / `department_ids` | both list calls | `contact:contact.base:readonly` |
| department `name` (builds the `open_department_id → name` map) | departments/children | `contact:department.base:readonly` |
| `enterprise_email` (the `@fenchem.com` mailbox) | find_by_department | `contact:user.employee:readonly` |
| `status.is_resigned` / `status.is_exited` (the skip filter) | find_by_department | `contact:user.employee:readonly` |

**Three tenant scopes — no more, no less.** Import JSON for 权限管理:

```json
{
  "scopes": {
    "tenant": [
      "contact:contact.base:readonly",
      "contact:department.base:readonly",
      "contact:user.employee:readonly"
    ],
    "user": []
  }
}
```

**Why `contact:user.employee:readonly` is mandatory, not optional.** `is_resigned` / `is_exited` sit in the *employment-information* category, gated by the **same** scope as `enterprise_email`. `isActiveContact` (contactsMirrorSync.ts) returns `true` when `status` is **absent** — a deliberate fail-open so a partial response is not mistaken for "everyone resigned". The consequence: if this scope is missing, the `status` field never arrives, the filter silently no-ops, and **resigned / exited employees get mirrored** — violating a hard requirement. So the skip filter is *load-bearing* on this scope, independent of whether anyone has an `enterprise_email`. A name-only "base" grant looks like it works (rows appear) while quietly breaking the filter.

**Why not the broad `contact:contact:readonly_as_app`.** One token covers all four fields, and it *was* this ADR's original stopgap — chosen by analogy to [ADR-0011](0011-feishu-permission-set.md) picking broad `bitable:app` over granular to dodge a wrong-identifier batch-import failure. We now take the granular set instead because (a) the per-field tokens are **verified against the official tables** (2026-06-03), so the import-failure risk that justified deferring is gone; and (b) the directory is sensitive PII — `readonly_as_app` reads the *entire* contact graph as the app, far broader than the four fields we store. Least privilege both ways: phones are excluded **by construction** (no `contact:user.phone:readonly` is ever requested, and `FeishuContactUser` in contactsMirrorRows.ts omits the field so it cannot be projected by accident), and the personal `email` field is never read.

**Scopes vs. data range are two independent gates — this is the crux of the 8-user bug.** A *scope* says **what kinds of fields** the app may read. The **data range** (应用可用范围 / 通讯录权限范围) says **which people / departments** are in view. The first live `fullSync` (2026-06-03) separated them cleanly: with a base contact-read scope already released, both calls returned `code:0` (so the scope is live — `call.ts` would otherwise throw) — yet `departments=0, users=8`, because the app's *data range* held only those 8 root members and no sub-departments. **Widening scopes cannot fix a narrow data range, and vice-versa. Both must be satisfied.**

## Dependencies (what unblocks the full crawl)

1. **Release the three tenant scopes above** (权限管理 → import JSON → 版本管理与发布 → 创建版本 → admin approval). A scope change is inert until a version is released and approved. Because these are *tenant*-identity scopes, **no user re-authorization** is needed.
2. **Widen the data range to the whole org** — 应用可用范围 / 通讯录权限范围 → **全部成员**. This is the gate that was actually bounding the crawl to 8 users / 0 departments; without it the other two scopes still only see those 8.
3. **Confirm with the live log.** A healthy `fullSync` shows `departments=<real>` and `users=<headcount>` with the `email` / `department` columns populated. If `email` is still blank after the range opens, the `contact:user.employee:readonly` release did not take — re-check the version approval.

> **Reality vs. the first draft of this ADR.** An earlier version said the app *"holds only `bitable:app` and cannot read the directory yet."* That is now **stale**: a base contact-read scope is live (name + avatar return for the 8 in-range users). The standing blockers are the **data range** and releasing the **employee/department field scopes** (for the resigned/exited filter, department names, and `enterprise_email`).

## Consequences

- **A new tenant scope + app release are prerequisites** (above). Until then the cron throws / returns empty and the mirror stays unpopulated — no other path regresses.
- **`open_id` is the stable natural key**, so unlike the Bitable record-id mirror the contacts mirror does not churn keys on re-import; the prune mostly handles leavers and newly-resigned users.
- **Avatar URLs can expire between biweekly runs** — consumers must degrade to initials (no `onError` storage hack).
- **Deploy backend + frontend in lockstep**: this adds Convex schema + a cron, so push Convex from the same commit (the backend is one shared deployment).
- **`bun run test` (full SPA suite) is not part of this change's verification** — the pure modules are covered by their own `vitest run` files; the registered handlers are framework-wrapped (no `convex-test`, per [ADR-0018](0018-request-sync-outbox-and-reconcile.md) conventions) and verified by the live `fullSync` run.

## Alternatives rejected

- **Per-keystroke live `search/v1/user` only (no mirror).** That is the *coworker picker* path (user-token, [ADR-0003](0003-feishu-user-scopes-and-search-v1.md)); it pays a cross-border round-trip per query and cannot back an email-sender → colleague match. A mirror is the directory analogue of the customer mirror.
- **Store personal `email` / fall back to it.** Explicitly rejected — only the `@fenchem.com` enterprise mailbox is wanted.
- **~~Granular per-field contact scopes — deferred~~ → ADOPTED (see Scopes).** Originally deferred for fear of a wrong-identifier batch-import failure (as with `bitable:app` in ADR-0011). Once the three tokens were verified against the official `权限要求` tables that risk dissolved, so the least-privilege set **replaces** the broad `contact:contact:readonly_as_app` stopgap. The broad scope is now the rejected alternative: it reads the whole contact graph as the app for no gain over the four fields stored.
- **Skip the prune (upsert-only).** That is exactly the drift that bit the customer mirror (ADR-0021); leavers would linger forever.
