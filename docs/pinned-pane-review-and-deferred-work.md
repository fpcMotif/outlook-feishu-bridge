# Pinned task pane — adversarial review, fixes, and deferred work

**Scope:** the "Make the Outlook read pane pinnable" change on branch
`codex/attachment-sync-latency-reduction` (commit `0d8854b`). It enables
`SupportsPinning` in both manifests and adds an `Office.EventType.ItemChanged`
handler in [`src/office/useMailItem.ts`](../src/office/useMailItem.ts) that
re-reads the open message so the pane follows the user across emails.

This document records an adversarial re-audit of that change (each finding was
verified against the actual code, then a second skeptic agent tried to overturn
the verdict), what was fixed, and the lower-priority work intentionally deferred.

> **Heads-up for future readers.** An earlier "thermo-nuclear" audit was written
> against a *different* branch (`feat/intake-v2-note-body-attachments`) that
> already had a `mailKey`-based remount. That branch's headline "High" — a
> metadata race in `readCurrentItem` — is a **false positive here** (our metadata
> path is synchronous). The real high-severity bug was the **opposite**: this
> branch shipped pinning *without* any remount, so intake state leaked across
> emails. Don't copy the old audit's line numbers; they don't match this tree.

## Verified findings (verifier + adversarial skeptic consensus)

| # | Finding | Verdict here | Severity | Status |
|---|---------|--------------|----------|--------|
| FH1 | Intake reducer state leaks across email switch in a pinned pane | **Confirmed bug** | **High** | **Fixed** |
| F1 | `readCurrentItem` publishes metadata without a generation guard | False positive (path is synchronous) | — | No action |
| F3 | Stale `selectedAttachmentIds` consume the attachment cap after a switch | Partial (cap math real; submit/preview safe) | Medium | **Deferred** |
| F2 | Module upload caches (`inFlight`/`completedStorage`) not reset | Partial (random-UUID keys ⇒ no correctness bug, only memory growth) | Low | Hygiene fixed; epoch-hardening **deferred** |
| F6 | `addHandlerAsync` registration failures silently swallowed | Confirmed (diagnostic only) | Low | **Fixed** |
| FH2 | `ItemChanged` handler registration/cleanup | No issue (stable callback, single registration, clean cleanup) | — | No action |
| FH3 | Convex existing-sync re-subscribe on `conversationId` change | False positive (snapshot is conversation-keyed, recomputed via `useMemo`) | — | No action |
| F4 | Degraded-host key fallbacks | Not applicable until a `mailKey` exists (now it does) | Low | **Deferred** (telemetry) |

## The high-severity bug (FH1) and the fix

**Symptom.** With the pane pinned, Outlook keeps one component tree mounted while
the user moves between messages; `useMailItem` re-reads on `ItemChanged`, but
`RequestIntakeScreen` mounted `RequestIntakeScreenCore` with **no `key`**
([`TaskPane.tsx:190`](../src/components/TaskPane.tsx)). So the `useReducer` intake
state survived the switch. The only reset was a render-time
`if (state.mailFrom !== mailItem.from) dispatch(mailFromChanged)`, and
`mailFromChanged` clears just `clientEmail` / `mailFrom` / `selectedCustomer` /
`customerTouched` — 4 of ~14 fields.

**Worst case (reachable):** submit a request for conversation A → `screen` becomes
`"received"` with A's `bitableRecordId`. Switch to an unrelated conversation B
that happens to share the sender → the `mailFrom` guard never even fires →
B is presented as *already synced to A's Base record*. The per-conversation
existing-sync overlay can't correct it, because that overlay only renders while
`screen === "build"`.

**Fix (conversation-scoped remount).** Base sync dedup is conversation-scoped
([ADR-0012](adr/0012-bitable-record-api.md)) — a conversation is one request — so
the right granularity is: *clean slate on a different conversation; preserve the
draft across sibling messages in the same thread.*

- New [`src/components/taskpane/mailKey.ts`](../src/components/taskpane/mailKey.ts):
  `deriveMailKey` → `conv:<conversationId>` (fallbacks `msg:<id>` then
  `mail:unknown`).
- [`RequestIntakeScreen.tsx`](../src/components/taskpane/RequestIntakeScreen.tsx)
  derives the key and forwards it; the stateful `RequestIntakeScreenCore` is keyed
  by it (directly in the logged-out path, via the Bridge in the logged-in path).
- [`RequestIntakeSyncBridge.tsx`](../src/components/taskpane/RequestIntakeSyncBridge.tsx)
  stays mounted (its existing-sync subscription re-keys in place via the
  `conversationId` arg — verified safe, FH3) and only remounts the keyed Core.

Tests: [`mailKey.test.ts`](../src/components/taskpane/mailKey.test.ts) and
[`RequestIntakeScreen.switch.test.tsx`](../src/components/taskpane/RequestIntakeScreen.switch.test.tsx)
(clean slate on conversation change incl. same-sender; preserved across siblings).

**Decision note (ADR-ready):** key granularity is *conversation*, not *message*.
Message-scoped keying would also fix FH1 + F3 but would wipe an in-progress draft
the moment the user reads a sibling message in the same thread, contradicting the
conversation-as-one-request model. If product later wants per-message reset,
promote this to an ADR superseding the rationale above.

### Smaller fixes shipped alongside

- **F6:** `addHandlerAsync` now passes a result callback that `dlog`s a failed
  registration (otherwise a failed pin silently stops re-reading).
- **F2 hygiene:** `resetIntakeUploadCaches()` clears the module-level upload Maps
  on conversation change (post-commit effect). This is memory hygiene only — see
  the deferred epoch-hardening below for the correctness-adjacent edge.
- **Lint debt:** `useMailItem` was already over the 50-line function cap at HEAD
  (66 lines) and F6 pushed it to 74. Extracted `registerPinnedPaneReread` and
  `publishCurrentItem` top-level helpers (extract-then-test seam,
  [ADR-0019](adr/0019-extract-then-test-seam.md)); the hook is now under the cap.

## What "uploading the local session" means (upload lifecycle)

A quick map of the intake upload flow, since the deferred items below touch it.
"Uploads" here are the salesperson's **locally-picked files** (drag/drop or file
picker) — distinct from mail attachments already on the message.

1. **Pick.** `useIntakeAttachments.addFiles` mints a random `crypto.randomUUID()`
   id per file and dispatches `filesAdded` into the reducer.
2. **Eager upload to Convex storage.** `queueIntakeFileUploads` POSTs the bytes to
   Convex File Storage *immediately* (not at submit), tracking the in-flight
   promise in the module-level `inFlight` Map and the resulting `storageId` in
   `completedStorage` ([`uploadIntakeFile.ts`](../src/components/taskpane/uploadIntakeFile.ts)).
   This is **Attachment staging** (see CONTEXT.md) — the bytes now live server-side.
3. **Submit.** `stageSelected` awaits any still-pending uploads, then hands the
   staged `storageId`s to `syncRequest` as `attachmentSources`. The Feishu Drive
   `upload_all` + Base row create run later in the **Deferred Base write** worker
   ([ADR-0022](adr/0022-attachments-and-mail-body-to-base-row.md)).

So the "local session" is this per-pane bookkeeping: the reducer's `uploadedFiles`
(React state, reset by the FH1 remount) **plus** the module-level `inFlight` /
`completedStorage` Maps (outside the React tree — these are what
`resetIntakeUploadCaches` now clears on conversation change). Because the ids are
random UUIDs, a stale entry can never attach to a new file; clearing is about not
growing the Maps across a long pinned session, not about correctness.

## Deferred / out-of-scope backlog

Ordered by priority. None block shipping the FH1 fix.

### 1. (Medium) Prune mail-attachment selection on message change within a conversation — F3
**Why deferred:** the FH1 remount already fixes the cross-conversation case. The
residue is *within* one conversation: reading sibling message B keeps message A's
`selectedAttachmentIds`, which are phantom on B (its `item.attachments` differ).
Submit and preview are safe (`collectSelectedMail` / `selectedAttachmentsForPreview`
intersect with the current `mailAttachments`), but `selectedAttachmentCount` counts
the phantoms, so the 10-file cap can be silently consumed and block selecting B's
own attachments.
**Plan:** add a `mailAttachmentsChanged` reducer action (sibling to the existing
`mailFromChanged`) dispatched from `useRequestIntakeScreen` when the message's
attachment-id set changes within a stable `mailKey`; it prunes
`selectedAttachmentIds` and `dismissedMailAttachmentIds` to ids present on the new
message. Keep `uploadedFiles` (local picks belong to the one request). Unit-test
the reducer action + a within-thread integration case.

### 2. (Low) Abort / epoch-guard in-flight uploads on conversation switch — F2
**Why deferred:** no correctness impact today (random-UUID keys; merge/queue only
read keys in current state). `resetIntakeUploadCaches` clears the Maps but does
**not** abort a running upload — its `.finally()` / `completedStorage.set` may
re-add one entry after the clear, and a late `dispatch` targets the unmounted old
reducer (at worst a no-op React warning).
**Plan:** introduce a monotonic upload epoch incremented in
`resetIntakeUploadCaches`; capture it per upload and ignore completions whose epoch
is stale (and/or thread an `AbortController` into `postBytesToConvexWithProgress`).
**Latent-landmine caveat:** today's harmlessness rests on two load-bearing facts —
(a) upload ids stay random `crypto.randomUUID()`s (no cross-conversation key
collision) and (b) the `key={mailKey}` remount of `RequestIntakeScreenCore`. If
*either* is ever removed, promote F2 from hygiene to a real fix.

### 3. (Low) Telemetry / dev-warning on degraded-host key fallbacks — F4
**Why deferred:** real Outlook hosts always provide `conversationId`, so
`deriveMailKey` hits `conv:`; the `msg:`/`mail:unknown` fallbacks only matter on
dev/degraded hosts where pinning isn't exercised. The `mail:unknown` bucket means
several id-less messages would not remount between each other.
**Plan:** `dlog` (dev-only) when `deriveMailKey` falls back, so a host that
unexpectedly omits `conversationId` is visible rather than silently sharing one key.

### 4. (Low) Pinned-pane data-path test coverage
**Why deferred:** the shipped tests cover `deriveMailKey` and the keyed-remount UI
behavior. Not yet covered: an end-to-end `ItemChanged`-driven reducer reset at the
`useMailItem → TaskPane` seam, and the within-conversation attachment-prune (item 1)
once it exists.
**Plan:** add these tests when item 1 lands.

## Second-pass adversarial audit — ultracode verifier + skeptic (2026-06-05)

A later narrow ("thermo-nuclear", via Cursor) pass re-flagged three items on this
branch. This entry records an **independent re-verification** — each finding run
through a correctness-trace lens, an adversarial-skeptic lens (tasked to *refute*),
and an impact lens — plus a fresh-eyes completeness sweep that surfaced issues the
narrow pass missed. *Confidence* = calibrated probability the item is a real,
fix-worthy bug **after** the skeptic's pressure; items were fixed when the harm was
real and the guard cheap/safe, regardless of a literal 80 cutoff.

| Finding | Conf | Sev | Verdict |
|---|---|---|---|
| Empty `body` persisted to Base on a fast Sync | 58 | High | **Fixed** (cheap guard; loss is total) |
| Attachment filenames leaked to Sentry breadcrumbs | 72 | Med | **Fixed** (data leak, NEW on branch) |
| Sibling-message nav binds preserved draft to the wrong message | 78 | High | **Deferred** — needs a product/ADR decision |
| Customer / clientEmail wiped on sibling sender change | 62 | Med | Deferred (F3 family) |
| `applyExistingSyncUpdate` generation not matched to submission | 45 | Med | Deferred |
| Self-forward retry result dropped by `runSync` generation bump | 55 | Low | Deferred |
| Cross-conversation "Already synced" via `internetMessageId` snapshot | 45 | Low | Deferred |
| `runSync` useCallback depends on whole `state` | 70 | Low | No action (dep is load-bearing) |
| render-time `mailFromChanged` dispatch ("dispatch in render") | 10 | — | No action (sanctioned React idiom) |
| Upload caches not aborted on switch | 12 | Low | No action (already F2) |

### Fixed in this pass

**1. Empty email body persisted to the Base row (High — data integrity).**
`useMailItem` publishes metadata with `body: ""` and `setLoading(false)` first, then
reads the real body in the background (`publishCurrentItem` → `readBodyInBackground`;
the body is an async `item.body.getAsync`, `mailBody.ts`). `buildSyncPayload.ts:22`
is the **sole** reader of `mailItem.body` and sends it verbatim, and `canSubmitSync`
had no body/loading guard. Reachable path: a **same-conversation sibling-message**
`ItemChanged` in a pinned pane — the conversation-scoped `mailKey` deliberately does
**not** remount the Core, so a complete draft survives while `useMailItem`
re-publishes `body: ""` during the new read. A Sync tap inside that (local,
~tens-to-hundreds-ms) window writes an empty body. Severity is **total loss**: per
ADR-0022 the Base row is the only home of the full body (the **Email Record** keeps
only a ≤500-char preview, itself derived from the same empty string). The skeptic's
mitigation (conversation-scoped dedup, ADR-0012) only covers a *repeat* submit of an
already-synced conversation — the **first** sync after a sibling switch has none.
**Fix:** a `bodyPending` signal on `MailItemData`, set true at publish and cleared
when the background read resolves *or* fails (`mailItem.ts`, `useMailItem.ts`),
threaded into the submit gate (`submitSyncGate.ts` `canSubmitSync` / `submitSyncHint`
→ "Wait for the email to load") via `useRequestIntakeScreen`'s `syncGate`. Mirrors
the existing `hasPendingSelectedUploads` gate; it guards the *consumer*, not the
by-design `body:""` placeholder (`useMailItem.test.ts` still asserts the placeholder).
Tests: `submitSyncGate.test.ts` (blocked while `bodyPending`) and
`useMailItem.test.ts` (pending true→false on success; cleared on read failure).

**2. Customer attachment filenames exfiltrated to Sentry (Medium — data leak, NEW).**
On a staging failure `runSync` logged `console.warn("[intake] skipped … : <names>")`
with raw attachment filenames. `console.warn` is rewired by `debug.ts` `wrapConsole`
into the debug buffer, which `sentry.ts` forwards to `Sentry.addBreadcrumb` — so
confidential filenames (customer contracts, pricing PDFs) left the device on any
captured error. New on this branch (the merge-base `runSync` had no such log).
**Fix:** log the count only, never the names (`useRequestIntakeScreen.ts`).

### Deferred / needs a decision

**(High) Sibling-message navigation binds a preserved draft to the wrong message.**
Sharpens deferred **F3**. Because `mailKey` is conversation-scoped, reading a sibling
keeps the draft *and* its `state.selectedAttachmentIds`, but `useMailItem` re-reads
so `mailAttachments` now reflects the sibling. At submit, `collectSelectedMail`
intersects the stale ids against the new item's attachments and `useAttachmentSync`
downloads from the **currently open** item — so files the user checked on message A
are silently dropped, and `buildSyncPayload` captures the sibling's
subject/body/`internetMessageId`. Not purely mechanical: it needs a product/ADR
decision — **which message in a multi-message conversation defines the request's body
+ attachments?** Options: (a) pin the request to the message it was started on
(snapshot subject/body/attachments at first edit); (b) prune selection to the open
message (original F3 plan) and accept body/subject following the open message;
(c) warn on a cross-message submit. Decide before coding.

**(Medium) Sibling sender change wipes a manually-chosen customer / client email.**
The render-time `mailFromChanged` dispatch clears
`clientEmail`/`selectedCustomer`/`customerTouched` whenever `mailItem.from` changes;
within one thread, a sibling reply from a different sender silently discards a
manually chosen **Customer** inside a draft the design means to preserve. Tie the
resolution to the F3 decision above (a started-on-message snapshot fixes both).

**(Medium) `applyExistingSyncUpdate` generation coordination.** After a fast submit
returns no `recordId`, `runSync` dispatches `syncQueued` but leaves
`activeSyncGenerationRef` set so the conversation-keyed `existingSync` subscription
can bridge pending→synced/failed. But `applyExistingSyncUpdate` only checks the ref
is non-null — not that it matches the in-flight submission — so a stale subscription
emission for a prior attempt can resolve a *newer* `runSync` generation (then null
the ref so the genuine result is dropped). Fix by capturing the generation when
arming and comparing it in `applyExistingSyncUpdate`.

**(Low) Self-forward retry result dropped by `runSync`'s generation bump.**
`fireSelfForward` guards its terminal dispatch on `generationRef`, but `runSync`
bumps that same counter — so tapping a self-forward retry and then Sync strands the
self-forward chip in "sending". The counter conflates two independent async ops;
give the self-forward its own generation ref.

**(Low) Cross-conversation "Already synced" via `internetMessageId` snapshot.**
`requestSyncSnapshot`'s `message:<userEmail>\n<internetMessageId>` fallback key is
conversation-id-agnostic, so if one mailbox ever reuses an `internetMessageId` across
conversations (forwarded/duplicated message), conversation B can momentarily render
A's "Already synced" record until the authoritative Convex query answers. Safety
rests on `internetMessageId` never recurring per mailbox.

### Considered and intentionally not changed

- **Render-time `mailFromChanged` dispatch is intentional**, not the parent-setState
  anti-pattern: it targets the *local* `useReducer`, is guarded by a primitive
  comparison that converges (the reducer sets `mailFrom`, so the in-render re-run
  bails), and React re-runs before commit — strictly cheaper than a `useEffect`. Do
  **not** migrate it into an effect (that adds a committed render + a flash). Its only
  real residue is the F3 family above.
- **`runSync`'s `[… state …]` useCallback dep is load-bearing.** `buildSyncPayload`
  consumes the whole `state` object, so narrowing the dep to slices (as the audit
  suggested) would capture a stale `state` in the payload — a correctness regression.
  Per-keystroke re-creation is cheap (`runSync` is only handed out as `onRetrySync`);
  leave the whole `state` dep.

## Risk verdict

**Low risk to ship.** The dominant, user-visible correctness bug (FH1) is fixed
and regression-tested; lint and typecheck are clean on the touched files. The
deferred items are bounded, lower-severity, and documented above with concrete
plans. The audit's original "High" (F1) and two of its mediums (FH3, F4) do not
apply to this branch's code.
