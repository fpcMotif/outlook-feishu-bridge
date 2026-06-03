# Colleague picker search — preload-once + client-side Pinyin matcher

> **Status: accepted (implementing).** Supersedes the live-Feishu-per-keystroke `searchCoworkers` path + the hand-rolled client LRU cache in `src/hooks/useCoworkerSearch.ts`. Built on the Feishu Contacts Mirror ([ADR-0023](0023-feishu-contacts-mirror.md)); the read-side analogue of the Customer **preload** mode ([ADR-0013] / [ADR-0016](0016-customer-search-modes-and-observability.md)).

## Context

The colleague picker (`CoworkerPicker.tsx` → `useCoworkerSearch.ts`) currently fires a **cross-border, user-token Feishu `GET /search/v1/user` call on every keystroke**, wrapped in a hand-rolled client LRU (`cache` Map + `inflight` Map + `tokenFingerprint` + TTL/eviction) plus a `searchCoworkersCached` warm query. The live call is the documented **~2.7 s** mirror-miss tail, and the LRU exists only to paper over per-keystroke I/O races. Two new requirements landed:

- Names are **mixed Chinese + English** as stored (`"彭爱丽(Aili Peng)"`, `"杨俊琪(Jasper. Y)"`, `"James Liu"`), and must also match by **Pinyin**: full (`pengaili`), initials (`pal`), and partials (`aili`).
- The directory is one company, **≤800 employees** (mirrored by ADR-0023), and when the picker is scoped to a sales context it is **often <30 people**.

We ran an `ultracode` design workflow (`design-contact-search`, 18 agents): 4 rival architectures designed against the real code, a 3-lens adversarial panel, and a lead synthesis. **preload-client** won (latency 10 / scaleFit 10 / overall 8), ahead of server-index (7), server-bounded-scan (8), and hybrid-reactive (8). The decisive finding: the three rivals' high marks all depended on converting search to a **reactive `useQuery`**, which the panel **disproved against the code** — `CoworkerPicker.tsx` consumes `search` as a Promise-returning callback inside a debounced `setTimeout`, where a render-phase `useQuery` cannot live; and a reactive search opens a *new full-table subscription per distinct keystroke* and re-pushes the whole payload on every biweekly sync write, **relocating** the bandwidth cost rather than removing it. The repo's own precedents (`useCustomerDirectory`, `useCustomerSearchServerIndex`) are **one-shot, not reactive**.

## Decision

**Preload the whole bounded directory once per login; rank in memory on every keystroke with a pure Pinyin matcher; precompute Pinyin at sync time so the browser ships no dictionary.**

**Data model.** Reuse `feishuContacts` (no new table, no new index; the existing `by_text` / `searchBlob` stays untouched for the public `search` query). Add sync-time precomputed fields as backward-compatible `v.optional(v.string())`:
- `pinyinFull` — both spaced and glued forms in one string, e.g. 彭爱丽 → `"peng ai li pengaili"` (spaced → syllable-boundary prefix hits; glued → full `pengaili` + partial `aili` substring hits).
- `pinyinInitials` — `"pal"`.
- `pinyinAlts` — space-joined alternate readings for polyphonic chars + surname-position overrides (单 → `shan dan`, 重 → `zhong chong`).
- `nameFold` — lowercased, NFKC, full-width-folded copy of `name` for cheap client substring matching without per-keystroke renormalization.

`optional` means pre-backfill rows (or a char absent from the dict) **degrade to name/email matching, never crash**. Extend `ContactUpsertRow`, `upsertRowValidator`, `contactRowChanged`, and `mapUserToRow` so the diff-gated upsert rewrites rows on backfill and is a no-op afterward. Add one **public bounded** query `feishu/contactsMirror:listForPicker` (`take(800)`, slim projection `{openId, name, email?, department?, pinyinFull, pinyinInitials, pinyinAlts, nameFold}` — **no `avatarUrl`, see below**), with the `exceedsAssumedMax` alarm mirrored onto this **read** path (loud `console.error` if `take(800)` returns exactly 800, so truncation never silently drops a colleague).

**Read path.** A new hook `useColleagueDirectory(isLoggedIn)` clones `useCustomerDirectory.ts`: a **one-shot `convex.query(listForPicker)`** (NOT reactive `useQuery`) into a module-level singleton via `useSyncExternalStore` + a `refresh()` nonce, gated on **login** so the array is warm before the first keystroke. Per keystroke: **zero network, zero Convex**. `useCoworkerSearch` keeps its `(query) => Promise<Coworker[]>` signature but resolves **synchronously** from the preloaded array (`rankColleagues(q, directory.contacts)`), so the picker is a pure hook-internals swap. Because matching is synchronous and `CoworkerPicker` already cancels stale timers, the out-of-order/in-flight bug class the LRU managed disappears; output is capped to top-K (~20). The 250 ms debounce can shrink to ~0–60 ms (no I/O).

**Pinyin (split: dictionary at sync time, matching at keystroke time).** Library **`pinyin-pro`** (pure JS, no Node built-ins → runs in the V8 cron action; dictionary never reaches the SPA). New **pure** module `convex/feishu/pinyinTokens.ts` exporting `buildPinyinKeys(name)` + `foldName(name)`. Correctness fixes verified against the official docs, pinned by golden tests:
- `surname: 'head'` (surname only at position 0) — **not** `'all'`, which mis-reads medial chars like 乐.
- initials via `pattern: 'first'` (first letter per syllable) — **not** `'initial'` (consonant clusters; zh/ch/sh → 2 letters), so 彭爱丽 → `pal` actually comes out.
- polyphones: iterate **per-character** with `multiple: true` and union readings into `pinyinAlts` (it does not enumerate over a whole name).
- toneless (`toneType: 'none'`), lowercased.
- Han-coverage assertion at sync: every Han char maps to ≥1 reading, else log loudly.

**Ranking** is our own pure code, not a search library (the panel called BM25-over-pinyin-tokens noisy): `src/components/taskpane/colleagueRank.ts` with a tiered scorer **exact > prefix > initials > substring**, deterministic tie-break (department-scope then name asc), matching against `nameFold` / `pinyinFull` / `pinyinInitials` / `pinyinAlts` / `email`.

**Freshness — biweekly + refresh only (decided).** No live-Feishu fallback. A brand-new hire/rename is invisible until the next biweekly sync or a panel-open `refresh()` kick. This fully eliminates the cross-border per-keystroke path.

**Avatars — included in the preload (revised 2026-06-03).** Originally dropped (lazy-load on selection) to keep the payload lean, but the search *dropdown* needs photos, so `listForPicker` ships `avatarUrl` after all (~5–80 KB extra across ≤800 rows — acceptable at this scale). The URLs are volatile (ADR-0003); `CoworkerOption` already falls back to the coworker icon on a 404, and the biweekly sync re-stamps them.

## Build refinements (2026-06-03)

- **Single CJK character is searchable.** The matcher's 2-char minimum applies to Latin only; a 1-char CJK query is a meaningful unit, so 冬 finds 陈冬冬 (and any contained run — 冬冬, 陈冬 — via true JS `.includes()`/prefix). This is a concrete advantage over both Feishu's tokenized `/search/v1/user` and the Convex `by_text` CJK tokenizer, neither of which does clean single-char substring.
- **Avatars need no rendering change.** `CoworkerOption` already falls back to the coworker icon when `avatarUrl` is absent, so dropping it from the preload "just works" — the dropdown shows icons; a real photo for the *selected* colleague can be lazy-fetched later.
- **Latency tracing.** `useCoworkerSearch` logs each search's duration via the existing `dtime`/`dlog` debug seam and warns past a **20 ms** budget (with a session-max), so the in-memory scan time is visible on the DebugPanel and a regression (or a directory that outgrows the preload) is loud. From China the backend RTT is ~150–350 ms, so this <20 ms target is *only* reachable with the local scan — which is itself the decisive argument for preload over any per-keystroke server call.

## Official sources (the only source of truth)

- `pinyin-pro` — https://github.com/zh-lx/pinyin-pro (MIT) + API docs https://pinyin-pro.cn ; options `toneType`, `pattern: 'first'`, `surname: 'head'`, per-char `multiple: true`. Single-purpose conversion lib (not a backend wrapper), pinned at install; dictionary choice (`@pinyin-pro/data` modern vs built-in) recorded at implementation.
- Convex text search (tokenizer limits): https://docs.convex.dev/search/text-search
- Convex bundling (single 32 MiB source bundle — why `pinyin-pro` lands in the bundle but fits with headroom, pure-JS, no `use node`): https://docs.convex.dev/functions/bundling
- Feishu `GET /search/v1/user` (the per-keystroke call being removed; ADR-0003): https://open.feishu.cn/document/server-docs/contact-v3/user/search

## Consequences

- **Net code removal** (the preferred direction): delete the client LRU machinery in `useCoworkerSearch.ts`; delete the live `searchCoworkers` action + `searchCoworkersCached` + the `coworkerSearchCache` table + its 4 cache fns + cleanup cron (separate cleanup commit, grep refs first).
- One-time **login payload** of the bounded directory (~10–30 KB today / ~250–400 KB worst case at 800 without avatars).
- New **dependency** `pinyin-pro` in the Convex bundle (~930 KB unpacked; fits the 32 MiB cap with headroom; pure-JS).
- **Backfill** is a `fullSync` rerun that rewrites every row's pinyin fields; the mirror is now live (~46 rows) so this runs today (respects the 15-min single-flight lease).
- Testability via the ADR-0019 seam: `pinyinTokens.ts` and `colleagueRank.ts` are pure → plain `vitest` (scoped `bunx vitest run`, never the full suite); the registered `listForPicker` query stays `v8-ignore`d.
- **Deploy backend + frontend in lockstep** from the same commit (the backend is one shared deployment); dev e2e stays non-submitting (ADR-0018).

## Alternatives rejected

- **server-index** (enrich `searchBlob` + reuse `by_text`; panel 7). Its killer-risk mitigation ("keep `pinyin-pro` out of the per-keystroke search module") is impossible — Convex bundles all of `convex/` into one source bundle, and `contactsMirror.ts` (exports `search`) imports the row builder. Forces a reactive-`useQuery` UI rewrite it hand-waved; leans on noisy BM25-over-pinyin-tokens; a full-text index is overkill at <800 rows by its own reviewer.
- **server-bounded-scan** (drop `by_text`, in-process bounded scan; panel 8). Rejected on the reactive-`useQuery` model (contradicts the repo's one-shot precedent; opens a full-table subscription per keystroke that re-pushes on every biweekly write) and its `surname:'all'` / `pattern:'initial'` pinyin spec was wrong. Its **non-reactive** variant collapses into preload-client minus the one-time fetch. Grafted: the tiered ranker, `nameFold`, the read-path alarm.
- **hybrid-reactive** (full set in one reactive `useQuery`; panel 8). Same data model as preload, but a standing subscription re-pushes ~80–150 KB on every `applyPage` batch and depends on push-only discipline the repo's own `kickMirror` pattern undermines. Preload achieves identical keystroke latency with no standing subscription — strictly cheaper.
- **Keep current** (live-Feishu-per-keystroke + manual LRU). Rejected outright — it *is* the ~2.7 s cross-border cost and the LRU the user dislikes.
