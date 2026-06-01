# Feishu user-data calls use user_access_token + explicit OAuth scopes; Search Users stays on /search/v1/user

> **Status: accepted; amended by [ADR-0010](0010-pivot-to-bitable-intake.md) + [ADR-0011](0011-feishu-permission-set.md).** The scope *mechanism* below still holds, but the current user set is `contact:user:search` + `offline_access` only (the `im:chat:readonly` / `im:message` chat scopes were dropped), now on app `cli_aa9a8daf16e2dcdb`. See [ADR-0011](0011-feishu-permission-set.md) for the full permission contract (incl. tenant `bitable:app`).

The bridge searches the directory for real coworker `open_id`s, so that call uses a **user access token**, not the app/bot (tenant) token. Feishu only puts a user-identity scope into the token if it is named in the OAuth `authorize` request's `scope` parameter; our login originally sent **no** `scope`, so every user-identity call failed with **`99991679`** ("app did not obtain the user's authorization"). The login now requests only `contact:user:search offline_access`.

User-visible Coworker search has a single source of truth: real Feishu directory data. The live fallback is Feishu Search Users; the small-org **Coworker Directory** mirror introduced below is also populated only from official Feishu Contact APIs. Static or made-up coworker fixtures may exist only inside automated tests; they must not appear as fallback results when a real Feishu search fails.

## On the `v1` in `/open-apis/search/v1/user`

`GET /open-apis/search/v1/user` (keyword in the `query` URL param, scope `contact:user:search`, `user_access_token`) is the **current** official Search Users API — verified directly against the open.feishu.cn docs (both the `contact-v3/user/search-users` page and the older page; neither carries a deprecation / 旧版 banner). The `v1` is **not** legacy and there is **no** `contact/v3` search-users replacement. Do not "upgrade" the path.

The real defect was the *call shape*: `coworkers.ts` originally issued a **POST with the keyword in a JSON body** and read a non-existent `avatar_url`. Fixed to a **GET** with `?query=`, mapping `avatarUrl` from Feishu's `avatar` object (`avatar_72`, falling back through larger sizes when a tenant response omits 72px).

## Consequences

- **Scope changes force re-login.** Adding or removing a requested scope only takes effect after each user logs out and re-authorizes; tokens minted earlier keep their old scope set.
- **`offline_access` is load-bearing.** Once `scope` is sent explicitly, the OIDC token endpoint returns a `refresh_token` only when `offline_access` is among the requested scopes — dropping it would break `userAuth`'s silent refresh.
- **Least privilege.** We request only the scopes actually exercised; `contact:user.base:readonly`, `im:chat:readonly`, and `im:message` are unused by the current Base sync flow. Search Users returns name/avatar/open_id under `contact:user:search` alone; `user_id` would need `contact:user.employee_id:readonly`, which we don't use.
- **No synthetic production results.** If real Coworker search cannot authenticate or Feishu returns no match, the UI must show no matching Coworker rather than sample people. Made-up coworkers are test fixtures only.
- **Short-query guard.** The taskpane coworker search starts remote lookup at two characters without starting a debounce timer for one-character production input, and the public Convex query/action enforce the same boundary before session/token/cache/Feishu work. One-character input is too broad for Feishu Search Users and returns no remote results instead of calling Convex/Feishu.
- **Tenant-identity calls are unaffected.** Bot-webhook posts, Doc creation, and Base writes use the tenant token and were never implicated in `99991679`.

## Amendment (2026-06-01) — Coworker avatar URL is volatile; fallback to initials, measure before tuning

Coworker avatars come from the same Search Users response (`avatar.avatar_72` → larger sizes → `avatar_url`) and normally load fine. But a Feishu avatar URL appears **time-bound**: a result cached in `coworkerSearchCache` (TTL 5 min) can serve a URL that has since expired, so the photo 404s. The picker already degrades gracefully — Radix `Avatar.Fallback` renders on image **error**, not only on an absent image — so there is no blank-circle bug. Decisions:

- **Fallback shows name initials**, matching `FeishuProfile.tsx`, rather than the generic `UserRound` glyph. An expired / absent / slow-loading avatar then yields a coworker-identifying cell. **No `onError` handler is added** — Radix already falls back on error, so it would be redundant.
- **The avatar URL is treated as volatile, not durable.** It is never persisted to Bitable or a CDN to "fix" freshness (HARD RULE + needless storage/sync surface).
- **The TTL / re-fetch-on-expiry decision is deferred pending measurement.** Instrument avatar load success/failure by cache age (alongside the existing `[coworkers] … avatars=N` log) and only then decide whether to shorten `COWORKER_SEARCH_CACHE_TTL_MS` or re-fetch on fallback. No blind TTL change on an unmeasured URL lifetime.

## Amendment (2026-06-01) — User-token refresh: error taxonomy, one transient retry, auto-logout on dead refresh_token

`getUserAccessToken` threw a single generic `User not authenticated` for the no-session case and called `refreshUserToken` with **no error handling**, so a logged-in user's coworker search failed identically whether the session was missing, the refresh_token was terminally dead, or a cross-border CN↔US blip interrupted the refresh. Conflating the recoverable case with the terminal ones is the defect. Decisions:

- **Three distinct outcomes, not one:**
  - `SESSION_MISSING` — no session row → show login (terminal).
  - `REFRESH_FAILED_TERMINAL` — Feishu reports the refresh_token invalid/expired (e.g. `invalid_grant`) → **delete the session row** so the UI honestly shows login; a dead refresh_token can never recover.
  - `REFRESH_FAILED_TRANSIENT` — network / 5xx during refresh → surface a **retryable** error and **keep** the session.
- **One transient retry** with a short backoff inside `refreshUserToken`; never retry a terminal `invalid_grant`.
- **Secret-safe logging:** `refresh_token` presence (bool), Feishu response code, elapsed ms — never token values.
- **`offline_access` stays load-bearing** (above): without the refresh_token there is no silent refresh and every expiry collapses to `SESSION_MISSING`.

## Amendment (2026-06-01) — Small-org Coworker Directory mirror for near-zero Search Users calls

The real Feishu tenant has fewer than 800 users, so paying a live Search Users call for every distinct coworker query is unnecessary once the directory has been refreshed. The new **Coworker Directory** is a Convex read model populated from official Feishu Contact APIs, then searched locally before falling back to `/search/v1/user`.

Official-source constraints:

- **Search Users remains the fallback and compatibility path.** It is still `GET /open-apis/search/v1/user`, requires a `user_access_token`, takes `query` in the URL, defaults `page_size` to 20, and allows up to 200. We keep `contact:user:search` for this path and do not invent a `contact/v3` search replacement.
- **Directory refresh uses tenant identity and Contact API visibility range.** Feishu documents that `GET /open-apis/contact/v3/users/find_by_department` may be called with `tenant_access_token`; for department `0`, the app must have full-member contact visibility, and the API returns only users in the app's contact permission range. The request uses `department_id_type=open_department_id`, `user_id_type=open_id`, `page_size=50` (the documented max), and `page_token`.
- **Department traversal uses the documented path form.** The root traversal is `GET /open-apis/contact/v3/departments/0/children` with `fetch_child=true`, `department_id_type=open_department_id`, `page_size=50`, and `page_token`. Feishu documents a 1000-department upper bound when recursive `fetch_child=true` is used; this product's user-count assumption is smaller than that.

Implementation decisions:

- The daily cron calls `coworkers.fullDirectorySync`, but the sync is inert until `FEISHU_COWORKER_DIRECTORY_SYNC=1` is set. This avoids noisy production failures before the Feishu console permission/range change is deliberately made.
- A fresh directory (`lastStopReason=complete`, age <= 25h) is preloaded into the taskpane and searched in memory before any Convex or live Search Users call. It also answers `searchCoworkersCached` and `searchCoworkers` for non-preloaded paths. When the mirror is absent, stale, disabled, or failed, the existing Search Users path still runs.
- Broken Contact API pagination is treated like the Customer Mirror: `has_more=true` without a fresh `page_token`, or with a repeated `page_token`, records a failed sync and throws. Silent truncation is not allowed.
- The mirror is bounded to 1000 users as a product invariant, deliberately above the stated <800 tenant size but below an accidental large-tenant rollout. If the tenant grows past that, the sync fails loudly instead of turning a small-org optimization into a broad directory product.

Refs:

- Search Users: https://open.feishu.cn/document/server-docs/contact-v3/user/search-users
- Find users by department: https://open.feishu.cn/document/server-docs/contact-v3/user/find_by_department
- Department children: https://open.feishu.cn/document/server-docs/contact-v3/department/children
