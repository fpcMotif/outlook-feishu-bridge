# Adversarial Attachment Fill test suite (ADR-0027)

Status: finalized. **All 8 test files green: 66 passed + 8 expected-fail (74 tests).**
Lint (project config) exit 0; `tsgo -b --noEmit` exit 0. The suite confirms **five
distinct SUT defects**, each encoded as an `it.fails` that auto-flips green when the
bug is fixed, plus a wall of passing characterizations that lock in the safe paths.

Cross-reference: [ADR-0027 — Deferred Attachment Fill](adr/0027-deferred-attachment-fill.md).

> Built by an `ultracode` Workflow (simulation harness → adversarial fan-out → skeptic
> verify → mutation teeth-check). Reviewed and corrected by hand afterwards (the
> concurrency family's flaky characterization was made deterministic; this report was
> completed to cover all 8 files — the workflow's synthesis agent only saw 3 of the 7
> families' structured results).

## What the harness simulates

The harness lives in `convex/feishu/attachmentFillSim/`. We cannot drive the real
Feishu Base/Drive, so it models them in memory and mimics the Outlook send/confirm
intake, then runs the **real** Convex handlers end to end against a faithful in-memory
Convex runtime. Only the I/O boundary is mocked.

| Real (under test) | Simulated / faked |
| --- | --- |
| `requestSync.ts` (`syncRequest`, `processPendingBitableSync`, `fillRowAttachments`, `rearmConversationSync`, `reconcilePendingBitableSync`) | `callFeishu` / `resolveFeishuToken` → `FeishuBaseSim` (in-memory Base + Drive) |
| `bitable.ts` (`createServiceRecord`, `patchRowAttachments`) | `getStorageBytes` → `FakeStorage` |
| `emails.ts` (all fill mutations/queries, incl. `listDueAttachmentFills`) | `ctx.db` → `FakeDb`, `ctx.scheduler` → `FakeScheduler`, `ctx.storage.delete` |
| `drive.ts` (`mintOneStagedSource`, `driveUploadConcurrency`, `withDriveRateLimitRetry`) | the `internal.*` dispatcher → `Registry` |
| `serviceRow.ts`, `attachmentFill.ts`, `bitableSyncRetry.ts` | — |

The ONLY mocked seam is `./call` (`callFeishu`, `resolveFeishuToken`) and `../storage`
(`getStorageBytes`), delegated into the current test's harness via a `vi.hoisted`
holder. The `FakeDb`, `FakeScheduler`, and `FakeStorage` reproduce the load-bearing
Convex contracts the SUT depends on: shallow-merge `patch` with delete-on-`undefined`,
`undefined` sorts lowest in an index (so `.gte(0)` excludes the sentinel), deep-copied
reads, unique `_id`/`_creationTime` on insert, and `scheduler.runAfter(delay)` →
`dueAt = now + delay`. The dispatcher resolves a Convex `FunctionReference` to its real
`._handler` by canonical name (`getFunctionName`), throwing loudly on an unregistered
ref so a pipeline gap can never silently no-op. This faithfulness is what makes e.g.
the 140-min cumulative retry schedule a real-runtime finding, not a harness artifact.

### Harness files

- `attachmentFillSim/index.ts` — `createHarness()` entry + `Harness` type (barrel).
- `attachmentFillSim/harness.ts` — orchestration: `submit` / `sendAndSettle` / `startFill` / `rearm` / `runDue` / `driveToCompletion({maxRounds})` / `advanceTimeMs`, accessors (`getByMessageId`, `lookupFor`, `pendingJobs`), `makeIntake`, `wireMocks`.
- `attachmentFillSim/fakeConvex.ts` — `FakeDb` (5 indexes), `FakeStorage`, `FakeScheduler`, `Registry`, `buildHarnessCtx` (the in-memory Convex runtime).
- `attachmentFillSim/feishuBaseSim.ts` — in-memory Base + Drive: `recordIds`, `salesFilesTokens`, `salesFilesPuts`, `mintedTokensFor`, `mintedCount`, `uploadConcurrencyPeak`, fault knobs (`failCreateOnce`, `failPutMatching`, `failUploadFor`, `deferUploadFor`, `rateLimitNextUpload`, `setUploadConcurrencyCap`, `gateUploads`).
- `attachmentFillSim/outlookIntake.ts` — `makeIntake` fixture factory (unique fileNames/storageIds; stages bytes into `FakeStorage`).
- `attachmentFillSim/README.md` — the owner invariant + the copy-paste `vi.mock` seam.

## The owner invariant the suite proves

When a row is created AND the intake carried attachment sources, the fill must:

- **(a)** ALWAYS run (kicked, never silently dropped),
- **(b)** target the SAME row this flow minted (never a foreign/ancient row, never any column but `Sales Files`, never the Feishu-owned `Request Type`), and
- **(c)** fully pend ALL file tokens — each source ends as a token on the row OR is observably skipped; never partial-and-silent, never duplicated.

## How to run (scoped commands ONLY — never `bun run test`)

```bash
bunx vitest run convex/feishu/attachmentFill.harness.smoke.test.ts
bunx vitest run convex/feishu/attachmentFill.always.test.ts
bunx vitest run convex/feishu/attachmentFill.fence.test.ts
bunx vitest run convex/feishu/attachmentFill.partial.test.ts
bunx vitest run convex/feishu/attachmentFill.concurrency.test.ts
bunx vitest run convex/feishu/attachmentFill.retry.test.ts
bunx vitest run convex/feishu/attachmentFill.compat.test.ts
bunx vitest run convex/feishu/attachmentFill.lifecycle.test.ts
```

Lint (project config): `bunx oxlint … convex/feishu/attachmentFillSim/ convex/feishu/attachmentFill.*.test.ts` → exit 0.
Typecheck: `bunx tsgo -b --noEmit` → exit 0.

### Results

| File | Passed | Expected-fail (`it.fails`) | Total |
| --- | --- | --- | --- |
| `attachmentFill.harness.smoke.test.ts` | 1 | 0 | 1 |
| `attachmentFill.always.test.ts` | 15 | 0 | 15 |
| `attachmentFill.fence.test.ts` | 15 | 1 | 16 |
| `attachmentFill.partial.test.ts` | 9 | 1 | 10 |
| `attachmentFill.concurrency.test.ts` | 4 | 1 | 5 |
| `attachmentFill.retry.test.ts` | 5 | 1 | 6 |
| `attachmentFill.compat.test.ts` | 4 | 3 | 7 |
| `attachmentFill.lifecycle.test.ts` | 13 | 1 | 14 |
| **Total** | **66** | **8** | **74** |

`it.fails` entries are green: they assert the owner-DESIRED state that fails today and
auto-flip green when the SUT is fixed. They map to **5 distinct defects** (the
window-vs-span defect is encoded in 4 files; see below).

### Mutation teeth-check (proves the suite bites)

Four deliberate SUT defects were seeded, the relevant family went red, then the edit
was reverted (`git checkout --`) — tree left clean:

| Seeded defect | Caught by |
| --- | --- |
| `mayUpdateOwnedBitableRow` always returns true | fence (ancient-row, boundary), + retry/lifecycle/partial window tests |
| persist-before-delete inverted (delete before persist) | partial (crash-between-persist-and-delete → lost token) |
| drop the `scheduler.runAfter` fill kick in `markBitableSyncSucceeded` | always (fill-always-runs, full-pend), smoke |
| `buildServiceAttachmentFields` also writes a 2nd column | fence + always column-scope |

No coverage holes among the seeded defects.

## Scenario families

- **smoke** — happy path: a 3-source intake fills exactly 3 distinct `file_token`s onto the SAME minted row, `Sales Files` column only, blobs deleted, sources drained, status `filled`.
- **always** — the anchor invariant whole for N ∈ {1,2,5}: fill kicked iff sources exist; multi-wave cumulative PUTs are monotonic; correct row; column scope; dedup short-circuit.
- **fence** — the runtime ownership + freshness guard: missing-provenance / undefined-mintedAt / ancient-row refusal, `<= window` inclusive boundary, column scope, no-`bitableRecordId` noop, + the integration window-vs-span defect through the real handlers.
- **partial** — persist-before-delete, crash replay (only the un-minted tail re-mints), dead/oversize source skipped+observable, mixed-wave atomicity, + the window-vs-span defect at the wave level.
- **concurrency** — two overlapping fills with no per-row lock; the gated-interleave double-mint, plus invariant-(b) bounding (right row/column under the race) and serial-idempotency.
- **retry** — the per-task retry chain: cumulative offsets `[5,20,80,140]` min, MAX-attempts termination (no infinite reschedule), exactly-once across a wave-break+retry, `99991400` transparent recovery, terminal-sentinel rearm gate, + the window-vs-span defect.
- **compat** — legacy `attachments` + `attachmentSources` interaction; begin re-attempt token-wipe / source-reset (weak points #4 #5).
- **lifecycle** — `pending → filling → filled/failed` + recovery: `recordAttachmentProgress` writing `filling`, `shouldRearmAttachmentFill` incl. `filling`, the `listDueAttachmentFills` index-backed sweep, the no-cron recovery gap, + the default-window late-retry defect.

## Confirmed SUT bugs — RANKED (severity × likelihood)

| # | Title | Sev × Likelihood | encodedAs (file) | Status |
| --- | --- | --- | --- | --- |
| 1 | **Retry span (~140 min) outruns the default 120-min freshness window** → a late retry mints a Drive token `patchRowAttachments`' fence permanently refuses → source minted-but-silently-dropped (empty cell, status `failed`) | **HIGH × HIGH** | `it.fails` ×4: fence, retry, lifecycle, partial | ACTIVE on the happy retry path |
| 2 | **Concurrent-fill double-mint (no per-row lock)** → two overlapping fills each mint every source → duplicate cell tokens OR orphaned Drive objects (interleave-dependent); `mintedCount > sourceCount` | **MED × MED** | `it.fails`: concurrency | Likelihood *raised* by Stage D's new reconcile sweep racing the kick/rearm |
| 3 | **Legacy `attachments` + `attachmentSources` → the fill PUT clobbers the legacy create-time token** (a file the SPA pre-minted is dropped) | **MED × LOW** | `it.fails`: compat | Latent: Stage C flips the SPA to send sources only, but the server keeps both with no mutual-exclusion guard |
| 4 | **`beginBitableSync` re-attempt hard-wipes already-minted `bitableAttachmentFileTokens`** (`= undefined`) → minted Drive blobs orphaned + re-minted | **MED × LOW** | `it.fails`: compat | Latent: needs minted-tokens-present + no `bitableRecordId` (off the happy path) |
| 5 | **`beginBitableSync` re-attempt re-arms the FULL source set** (not the un-minted tail) → next fill re-mints already-minted sources (duplicate Drive uploads) | **MED × LOW** | `it.fails`: compat | Latent: same precondition as #4 |

### #1 — detail (the headline defect)

**Chain:** `bitableSyncRetry.ts` `nextRetryAt` adds `{5,15,60,60}` min per failure →
cumulative `+0/+5/+20/+80/+140` min from mint. `attachmentFill.ts`
`DEFAULT_BITABLE_UPDATE_WINDOW_MS = 120 min`; `mayUpdateOwnedBitableRow` requires
`now − bitableRowMintedAt ≤ window`, and `bitableRowMintedAt` is stamped once at create
(`emails.ts`, intentionally immutable provenance). The 5th attempt at `mint + 140 min`
mints the token and `recordAttachmentProgress` persists it (Drive quota consumed), but
`patchRowAttachments` then sees `140 > 120` → throws `Refusing Sales Files PUT…`;
`markAttachmentsFailed` at `attemptCount = 5` returns the terminal sentinel and the
chain stops. Terminal state: `bitableAttachmentFileTokens.length === 1`,
`salesFilesTokens(recordId) === []`, `bitableAttachmentSkipped === []` →
`accountedFor === 0 ≠ sourceCount`. Token neither on the row nor observably skipped.

**Contradicts** ADR-0027 §Consequences line 36 ("the bounded-retry span is kept inside
the window") and violates owner invariant (c). **Triggers** whenever a single source's
Drive upload is transiently unavailable through ~attempt 4 — exactly the `99991400`
storm / Drive-blip case the bounded-retry loop exists to handle.

**Fix (any one closes it):** (a) tie the attachment retry schedule to
`bitableUpdateWindowMs()` — terminate or shorten so the cumulative span stays inside
the window (e.g. `+5/+10/+20/+40 = 75 < 120`); OR (b) exempt a self-minted row whose
tokens are already persisted (`bitableAttachmentFileTokens` non-empty AND
`bitableClientToken` matches) from the freshness clamp — provenance is sufficient there;
OR (c) on a terminal fence refusal, record the orphaned token's `fileName` in
`bitableAttachmentSkipped` so the source is at least observably accounted for.

### #2–#5 — fix sketches (in the test `// BUG:` comments)

- **#2:** take a per-row fill lease in `recordAttachmentProgress` (CAS), OR dedup `remaining` by `storageId` AND have `mintOneStagedSource` short-circuit a storageId already in this row's `fileTokens` — the mutation is the only true serialization point.
- **#3:** when `attachmentSources` is present, do NOT also pass `attachments` to `createServiceRecord` (fill is the single writer), OR seed the cumulative tokens with the legacy ones so the coalesced PUT unions instead of clobbers.
- **#4/#5:** in `beginBitableSync`, on a re-attempt do NOT blanket-wipe `bitableAttachmentFileTokens`; preserve already-minted tokens and re-arm only the un-minted tail (`bitableAttachmentSources`), not the full re-submit set.

## Weak points the suite REFUTED-as-safe (locked in by passing characterizations)

These suspected defects were probed adversarially and found NOT to be bugs **against
the current (Stage-D) code**; a regression would now be caught:

- Missing provenance (`bitableClientToken`) / undefined `bitableRowMintedAt` → fence refuses, row observably `failed` (not a silent PUT/drop). (fence)
- `<= window` boundary is inclusive; +1 ms is refused. (fence)
- Column scope — every fill PUT writes exactly `['Sales Files']` on the minted row, never `Request Type`, even under forced multi-wave. (fence, always)
- No `bitableRecordId` → noop (`{patched:false}`), no PUT, no fence error. (fence)
- Infinite reschedule on a windowed refusal — `MAX_BITABLE_SYNC_ATTEMPTS = 5` caps it; chain terminates with `attachmentNextRetryAt = undefined`, empty queue. (retry)
- Double-mint across a wave-break + retry — persist-before-delete + remaining-tail mints a transiently-deferred file exactly once. (retry, partial)
- Rate-limit (`99991400`) leaking into a deferral — `withDriveRateLimitRetry` recovers a storm transparently; token mints once, status `filled`. (retry)
- Terminal exhaustion staying rearmable — the undefined sentinel is excluded by `shouldRearmAttachmentFill`; a still-below-max `failed` row WITH a numeric next-retry IS rearmable (the sentinel, not the status, is the gate). (retry, lifecycle)
- Status independence — the row is `synced` while attachments are still filling; a stuck fill never flips the synced row. (lifecycle)
- Dead `filling` value — REFUTED under Stage D: `recordAttachmentProgress` writes `filling` and `shouldRearmAttachmentFill` includes it; a crashed mid-fill strand is rearmed to `filled` with no re-mint. (lifecycle)
- Index never swept — REFUTED under Stage D: `listDueAttachmentFills` queries `by_attachmentStatus_and_attachmentNextRetryAt` (sentinel excluded via the `≥ 0` lower bound) and `reconcilePendingBitableSync` drives it. **Narrowed real gap (characterized, not a bug):** no CRON runs reconcile (`crons.ts` registers only the 2 directory mirrors), so a strand whose self-reschedule chain died waits for a human reopen (rearm) or a manual `bunx convex run`. Suggested follow-up: a `crons.interval` over `reconcilePendingBitableSync`. (lifecycle)
