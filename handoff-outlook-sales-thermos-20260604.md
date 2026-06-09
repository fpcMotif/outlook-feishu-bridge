# Handoff: outlook-feishu-addin — post-thermos review fixes

**Written:** 2026-06-04  
**Workspace:** `C:\Users\fenchem\.cursor\worktrees\outlook-sales\y9xl`  
**Branch:** `cursor/bd339101` (vs `main`)  
**Next session focus:** Implement thermos merge blockers in priority order; do not merge as-is.

---

## Executive summary

A thermos (/thermos) branch review concluded **do not merge as-is**. The branch delivers ADR-0022 (attachments + mail body → Base row) and ADR-0024 (colleague preload search) with solid decomposition and test coverage, but has **four merge blockers**: an accidental `bun.lock` rewrite, **unauthenticated Convex file→Drive upload**, **reconcile cron that drops attachments (and truncates body) on retry**, and **duplicated picker UI** that still wraps synchronous search in debounced Promises.

The next agent should treat this as a **security + durability + maintainability** pass, not feature work. Start by reverting WIP lockfile noise, then fix auth on the attachment pipeline, then make reconcile replay faithful to the first sync attempt, then refactor pickers following the `AttachmentSection*` pattern.

---

## Current state

### Git / working tree

Uncommitted changes on `cursor/bd339101`:

| File | Status | Notes |
|------|--------|-------|
| `bun.lock` | Modified | **Accidental** — workspace semver pins rewritten to `"latest"`. **Revert entirely.** |
| `package.json` | Modified | **Intentional only change:** `@typescript/native-preview` `20260602.1` → `20260603.1`. Keep this bump; restore lockfile cleanly via `bun install` after revert. |
| `src/components/taskpane/icons/PdfFileIcon.tsx` | Modified | Whitespace-only. Revert or leave; no product impact. |

### Thermos verdict (synthesized)

- **Block merge:** H1 lockfile, H2 auth on Drive upload, H3 reconcile attachment/body loss, picker maintainability.
- **Should-fix (can be follow-up PRs):** contacts mirror PII exposure (M1), partial Drive upload orphans (M2), 800-row preload cap alarm (M4), fragile `"Email "` literal in `serviceRow.ts` (M5).
- **Solid — do not regress:** attachment UI decomposition, contacts mirror splits, Data From SingleSelect fix, markFailure spread fix, unit/e2e coverage, Mailbox 1.8 manifest floor, two-phase Sales write (create → PUT Sales).

### Branch scope (high level)

ADR-0022 adds: mail body + consolidated note + attachments on Base create; bytes staged via Convex File Storage → Feishu Drive `file_token`s → Bitable create. ADR-0024 replaces per-keystroke Feishu search with preload + in-memory Pinyin ranking. Submodule `coworker-picker/` was deleted; logic inlined into `CoworkerPicker.tsx` (~287 lines) and duplicated in `SalesPicker.tsx` (~199 lines).

---

## Assumptions

1. **Merge target is `main`** after blockers are fixed and thermos is re-run green.
2. **No npm/npx** — project uses `bun` / `bunx` only (`AGENTS.md`).
3. **Testing:** scoped `bunx vitest run <file>` only; **never** `bun run test` (full suite).
4. **Bitable HARD RULE:** create path only; never modify pre-existing rows; never write Feishu-owned **`Request Type`** column. Confirm live column names via `bunx convex run feishu/bitable:listFields` before changing constants in `convex/feishu/serviceRow.ts`.
5. **Convex public API = internet-facing.** Sensitive operations must use `internal*` or explicit session checks (`convex/feishu/userAuth.ts` pattern with `sessionId` + `feishuUserTokens` table).
6. **Idempotent create** uses stored `bitableClientToken` as Feishu `client_token` — attachment `file_token`s must be re-playable on retry without re-uploading bytes (ADR-0022 decision).
7. **Feishu Drive rate limit:** serial uploads, 5 QPS — do not parallelize `upload_all` (`convex/feishu/drive.ts`).

---

## Background / domain pointers

Read these before changing behavior (do not duplicate their content here):

| Topic | Path |
|-------|------|
| Domain language | `CONTEXT.md` |
| Project overrides (bun, testing, Bitable rules) | `AGENTS.md`, `CLAUDE.md` |
| Convex API rules | `convex/_generated/ai/guidelines.md` |
| Attachments + body pipeline | `docs/adr/0022-attachments-and-mail-body-to-base-row.md` |
| Outbox + reconcile cron | `docs/adr/0018-request-sync-outbox-and-reconcile.md` |
| Colleague preload search | `docs/adr/0024-colleague-picker-preload-pinyin-search.md` |
| Contacts mirror | `docs/adr/0023-feishu-contacts-mirror.md` |
| Initiator / Sales column | `docs/adr/0014-write-initiator-and-subject-to-service-row.md` |
| Extract-then-test seam | `docs/adr/0019-extract-then-test-seam.md` |

**Key runtime flow (Base Sync):** SPA stages attachment bytes → `storage.generateUploadUrl` + POST → `uploadAttachmentsToDrive` → `file_token`s → `syncRequest` → `createServiceRecord` + Email Record backup. Cron `reconcilePendingBitableSync` replays failed/pending backups.

---

## Prioritized implementation plan

### Blocker 1 — Revert `bun.lock` "latest" rewrite (H1)

**Goal:** Clean lockfile; keep only the `@typescript/native-preview` bump.

**Steps:**

1. `git checkout -- bun.lock` (or restore from `main` if checkout insufficient).
2. Confirm `package.json` retains only the native-preview version bump.
3. Run `bun install` to regenerate lockfile with pinned semver (not `"latest"`).
4. Optionally revert `PdfFileIcon.tsx` whitespace: `git checkout -- src/components/taskpane/icons/PdfFileIcon.tsx`.
5. Inspect diff: lockfile changes should be minimal and tied to the one devDependency bump.

**Code-judo:** Do this first so CI/review diffs are trustworthy before substantive fixes.

---

### Blocker 2 — Auth + storage ownership on attachment → Drive path (H2)

**Problem:** `convex/feishu/drive.ts` exports public `uploadAttachmentsToDrive` action with **no auth**. It accepts `{ storageId, fileName }[]`, reads bytes via `getStorageBytes`, uploads with **tenant** auth to Feishu Drive. Pairs with unauthenticated `convex/storage.ts` `generateUploadUrl` mutation — anyone who obtains/guesses a `storageId` could trigger tenant Drive uploads.

**Auth design options:**

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | Gate both mutations/actions on validated Feishu `sessionId` (lookup `feishuUserTokens`) | Matches existing login model; SPA already has session | Requires threading `sessionId` through upload URL mint + Drive action |
| B | Bind `storageId` to uploader at mint time (new `_storage` metadata table: `storageId → sessionId/openId`, TTL) | Defense in depth even if action stays public | Extra schema + cleanup |
| C | Make `uploadAttachmentsToDrive` **internal**; call only from authenticated `syncRequest` path server-side | Smallest public surface | Requires moving Drive upload into sync flow (may change SPA orchestration) |

**Recommendation:** **Option A + B (lightweight).**

1. Add `sessionId: v.string()` to `generateUploadUrl` and `uploadAttachmentsToDrive`; reject if session missing/expired via `userAuth` helpers.
2. On upload URL mint, record `{ storageId, sessionId, createdAt }` in a small table (or system metadata pattern). On Drive action, verify each `storageId` belongs to caller's session before read/delete.
3. Consider rate-limit per session (attachment count cap already exists client-side; enforce server-side too).

**Implementation sketch:**

- Extract pure `validateSession(ctx, sessionId)` helper (testable, ADR-0019).
- Update SPA attachment hook (`useIntakeAttachments` / `buildSyncPayload.ts` callers) to pass `sessionId`.
- Add unit tests: unauthenticated call throws; wrong session cannot read another's `storageId`.

**Do not:** expose tenant Drive upload to anonymous Convex callers.

---

### Blocker 3 — Reconcile cron drops attachments on retry (H3)

**Problem:** `convex/feishu/requestSync.ts` `reconcilePendingBitableSync` (~L235–249) replays `createServiceRecord` with fields from Email Record backup but **no attachments**. Comment at L241–242 acknowledges only `bodyPreview` (≤500 chars) is available — full body never persisted. `convex/emailRecord.ts` `toEmailRecord` sets `attachmentFileKeys: undefined`; schema has legacy `attachmentKeyValidator` but ADR-0022 uses Drive `file_token`s, not stored on backup today.

**Design tradeoffs (see ADR-0022):**

| Approach | Description | Tradeoff |
|----------|-------------|----------|
| **Persist tokens on outbox row** | Before/create during first sync, store `pendingAttachments: { fileToken, fileName }[]` (+ optionally full `body`) on Email Record; reconcile passes them through | Duplicates data on backup row; must validate tokens still valid in Feishu |
| **Defer Drive upload until post-create** | Stage bytes longer; upload only inside authenticated sync/reconcile after idempotent create succeeds | Conflicts with ADR-0022 "mint tokens BEFORE create" idempotency story — retry would re-upload bytes |
| **Hybrid (recommended)** | **Persist `file_token`s + full body on backup at sync start** (after Drive upload, before Bitable create). Reconcile replays same tokens + body. Tokens are idempotent with same `client_token`. | Small schema extension; aligns with ADR-0018 outbox model |

**Recommended steps:**

1. Extend `emailRecordFields` with optional `attachmentFileTokens: v.optional(v.array(v.object({ fileToken: v.string(), fileName: v.string() })))` and `bodyFull: v.optional(v.string())` (or reuse a single `syncPayload` object — prefer one additive field group to avoid drift).
2. In `syncRequest`, after Drive upload succeeds, **patch backup** with tokens + full body **before** Bitable create (or atomically in `begin` mutation).
3. Update `reconcilePendingBitableSync` to pass `attachments` + full `body` from backup, not `bodyPreview` alone.
4. Update `toEmailRecord` / mappers so first persist captures full body (preview remains for list UI).
5. Add comment in `gatherAttachmentSources.ts` (or successor) pointing to persisted tokens — remove stale "not available on retry" if fixed.

**M3 (same area):** Reconcile currently passes truncated `bodyPreview` — fixed by persisting full body as above.

**Code-judo:** Extract pure `buildCreateServiceRecordArgs(backup)` helper; unit-test reconcile mapping with/without attachments.

---

### Blocker 4 — Picker maintainability

**Problem:** `coworker-picker/` submodule removed; search UI duplicated in `CoworkerPicker.tsx` and `SalesPicker.tsx`. ADR-0024 made search **synchronous** (`useCoworkerSearch.ts` + `colleagueRank.ts`), but both pickers still use **250ms debounce + Promise façade** from the old async Feishu search era.

**Refactor plan (follow `AttachmentSection*` decomposition):**

1. **Extract** `usePersonPickerSearch({ recentsKey, previewFixtures, rankOptions? })` under e.g. `src/components/taskpane/person-picker/`.
2. **Make search synchronous:** `useMemo` + `rankColleagues`; remove debounce, cancel tokens, Promise wrapper. ADR-0024 allows ~0–60ms debounce at most (optional).
3. **Shared types:** Move `CoworkerOption` / row types to neutral module (`person-picker/types.ts`).
4. **Dismiss behavior:** Reuse `useOutsidePointerDismiss` from `taskpaneOutsideDismiss.ts` (mirror `CustomerPicker` pattern) if not already wired in both pickers.
5. **SalesPicker scope:** Wire `preferredDepartment` into ranking if ADR-0014 / sales context requires department-scoped search (`colleagueRank.ts` may already support — verify).
6. Shrink `CoworkerPicker.tsx` / `SalesPicker.tsx` to layout + wiring only.

**Code-judo:** Change hook internals first with existing tests; then collapse picker files. `useCoworkerSearch.ts` already documents the Promise shape is legacy — removing it is the goal.

---

### Should-fix (important, not necessarily same PR)

| ID | Issue | File(s) | Direction |
|----|-------|---------|-----------|
| M1 | `listForPicker` / `search` expose org PII without server auth | `convex/feishu/contactsMirror.ts` | Gate on `sessionId` or move to internal + authenticated wrapper |
| M2 | Serial Drive loop: mid-batch failure orphans uploaded files | `convex/feishu/drive.ts` | Compensating delete on failure, or upload-all-then-commit; document orphan risk |
| M4 | Hard cap ~800 rows in `listForPicker` | `contactsMirror.ts` | Ensure `exceedsAssumedMax` alarm fires; document truncation |
| M5 | Fragile `"Email "` literal for Data From SingleSelect | `convex/feishu/serviceRow.ts` | Centralize constant; confirm via `listFields` |

---

## Files to touch

### Blocker 1
- `bun.lock`, `package.json`, optionally `src/components/taskpane/icons/PdfFileIcon.tsx`

### Blocker 2 (auth)
- `convex/storage.ts` — `generateUploadUrl`
- `convex/feishu/drive.ts` — `uploadAttachmentsToDrive`
- `convex/feishu/userAuth.ts` — reuse session validation
- `convex/schema.ts` — optional `stagedUploads` table
- `src/components/taskpane/buildSyncPayload.ts`, attachment hooks, intake flow
- Tests: `convex/feishu/drive.test.ts` (or new), `convex/storage.test.ts`

### Blocker 3 (reconcile)
- `convex/emailRecord.ts` — schema fields + `toEmailRecord`
- `convex/feishu/requestSync.ts` — sync + `reconcilePendingBitableSync`
- `convex/emails.ts` (or wherever backup patch lives)
- `convex/feishu/bitable.ts` / `createServiceRecord` args if needed
- Tests: requestSync reconcile mapping, emailRecord round-trip

### Blocker 4 (pickers)
- `src/components/taskpane/CoworkerPicker.tsx`
- `src/components/taskpane/SalesPicker.tsx`
- `src/hooks/useCoworkerSearch.ts`
- `src/components/taskpane/colleagueRank.ts`
- New: `src/components/taskpane/person-picker/*`
- `src/components/taskpane/taskpaneOutsideDismiss.ts` (reuse)

### Reference / do not break
- `src/components/taskpane/AttachmentSection*.tsx`, `attachmentSelection.ts`
- `convex/feishu/serviceRow.ts` (column constants)
- `public/manifest.xml` (Mailbox 1.8 intentional)

---

## Testing strategy

1. **Unit (preferred seam):** Extract pure helpers; run scoped vitest:
   - `bunx vitest run convex/feishu/drive.test.ts`
   - `bunx vitest run convex/feishu/requestSync.test.ts` (or equivalent)
   - `bunx vitest run convex/emailRecord.test.ts`
   - `bunx vitest run src/components/taskpane/colleagueRank.test.ts`
   - Picker tests after refactor
2. **Auth tests:** Unauthenticated/m wrong-session calls must fail before storage read or Drive upload.
3. **Reconcile tests:** Backup with `attachmentFileTokens` + full body → reconcile args include attachments and full body.
4. **E2e:** Only if existing attachment/e2e specs cover sync path — do not run full e2e suite blindly.
5. **Manual smoke:** Login → select attachments → sync → simulate failure → verify cron replay includes attachments on Base row (requires dev Feishu env).

**Never:** `bun run test` (full suite). **Never:** `convex-test` in this repo.

---

## Out of scope (this handoff)

- Merging to `main` before thermos re-run
- Customer mirror / weekly cron changes
- Chunked Drive upload (>20 MB)
- Replacing reconcile cron with Feishu webhooks (ADR-0018 future work)
- Writing Request Type column or modifying pre-existing Bitable rows
- npm/npx migration or full-suite CI fixes unrelated to blockers

---

## Suggested skills

Invoke at session start or per phase:

| Skill | When |
|-------|------|
| `.agents/skills/convex` / `convex-setup-auth` | Auth gating on `generateUploadUrl` + Drive action |
| `.agents/skills/tdd` | Reconcile + Drive auth fixes (red-green on pure helpers) |
| `.agents/skills/handoff` | If chaining another session |
| `thermo-nuclear-review` / thermos | Re-run branch review after fixes |
| `.agents/skills/grill-with-docs` | If new fields need ADR-0022 / ADR-0018 amendments |
| `.agents/skills/review` | Pre-PR standards + spec check |
| `.agents/skills/react-doctor` | After picker refactor |
| Project: `.agents/skills/check-compiler-errors` | Typecheck before commit |

---

## Open questions

1. **Auth scope for contacts mirror (M1):** Should `listForPicker` require the same `sessionId` as Drive upload, or is login-only SPA gating enough for v1?
2. **Full body persistence size:** Email bodies can be large — is storing full plain-text on Email Record acceptable vs. Convex doc size limits? Consider cap + overflow strategy if needed.
3. **Drive token TTL:** If reconcile runs hours later, are Feishu `file_token`s from `upload_all` still valid for Bitable attach? Confirm against Feishu docs; may affect retry window.
4. **SalesPicker department scope:** Does product require `preferredDepartment` filtering now, or is CoworkerPicker-only ranking sufficient?
5. **Partial upload failure (M2):** Product decision: fail entire sync vs. best-effort partial attachments on retry.

---

## Quick start for next agent

```powershell
Set-Location "C:\Users\fenchem\.cursor\worktrees\outlook-sales\y9xl"
git status
git branch --show-current   # expect cursor/bd339101

# 1. Fix lockfile
git checkout -- bun.lock
bun install
git diff bun.lock package.json   # verify minimal diff

# 2. Read ADRs (paths above), then auth + reconcile + pickers in order

# 3. Test scoped
bunx vitest run convex/feishu/drive.test.ts
```

**Success criteria:** Thermos merge blockers H1–H4 resolved; security gap closed on storage→Drive; reconcile replays attachments + full body; pickers share one search hook without Promise/debounce façade; `@typescript/native-preview` bump retained; clean lockfile.
