# Deferred Attachment Fill — create the Base row first, patch attachments after

> **Status: accepted.** Reverses three clauses of [ADR-0022](0022-attachments-and-mail-body-to-base-row.md) (attachments-on-create, "writes ride the create path only", "reconcile drops attachments") and the serial-Drive-upload stance. Builds on [ADR-0012](0012-bitable-record-api.md) (the create-then-correction update lifecycle), [ADR-0018](0018-request-sync-outbox-and-reconcile.md) (the per-task outbox), and [ADR-0026](0026-upload-draft-restore-and-drive-fault-tolerance.md) (per-file Drive fault tolerance).

## Context

Under [ADR-0022](0022-attachments-and-mail-body-to-base-row.md) the **Attachment** files rode the **create** path: the **SPA** staged bytes to Convex, then called **Feishu Drive** `medias/upload_all` to mint `file_token`s, then `syncRequest` created the row carrying them. So the salesperson **waited for the entire Drive leg before the row existed** — and that leg is the dominant cost: a 10-file live trace measured `upload_all` at **~14 s**, run **serially** because earlier parallel runs hit rate-limit code `99991400`.

Two facts reframe this:

1. **Owner requirement.** The row must exist **immediately**, with an empty Attachment cell, and be filled incrementally afterward — the salesperson may close the pane the moment the row exists (走开也不会影响数据同步，无需傻等). The only thing they should wait for is the **local** byte hand-off, never the slow Feishu round-trips.
2. **Official limit.** The Feishu doc states `medias/upload_all` is **5 QPS, 10 000/day, ≤20 MB** — a *rate*, not concurrency-of-one. The "6 parallel → `99991400` at index 5" we observed is consistent with a **~5 ceiling**, so strictly-serial was over-throttled. On throttle the response carries `x-ogw-ratelimit-reset`, which the docs call the best signal for when to retry.

Latency-minimization is the explicit top priority for every decision below.

## Decision

- **Base Sync ends at row-create.** The Service row is minted with the **Request** note, email body, subject, **Customer**, **Coworker** and **Sales** committed atomically, and an **empty `Sales Files` cell**. **Attachment Fill** (new — see CONTEXT.md) is a separate, server-side, bounded-retry loop that writes the attachments onto that same just-created row afterward.
- **Independent attachment lifecycle.** Attachment Fill tracks its own state on the **Email Record** — `bitableAttachmentStatus` (`pending → filling → filled / failed`), `attachmentNextRetryAt`, `attachmentAttemptCount`, the cumulative `bitableAttachmentFileTokens`, `bitableAttachmentSkipped`, and `bitableAttachmentSources` — **independent of** `bitableSyncStatus`, with its own `by_attachmentStatus_and_attachmentNextRetryAt` index. This is required because the create-side recovery treats `bitableRecordId`-present as "done"; a stuck fill on an already-`synced` row needs its own rearm/sweep predicate (`shouldRearmAttachmentFill`). Recovery is two-tier: per-conversation **rearm-on-reopen** (the taskpane re-drives a stranded fill it observes) plus the manual `reconcilePendingBitableSync` CLI backstop, which also sweeps due fills via that index (`listDueAttachmentFills`) for the no-reopen, no-human-in-the-loop case.
- **Bounded-concurrency Drive upload (reverses ADR-0022's serial stance).** Attachment Fill uploads at **bounded concurrency, default 4, configurable, hard-capped ≤5** to stay under the 5 QPS budget; on `99991400` it honors `x-ogw-ratelimit-reset` rather than blind exponential backoff. Turns ~14 s → ~3 s for 10 files. The cap is **per-fill** — two overlapping fills can briefly exceed 5 QPS, but each upload's reset-header retry self-corrects; no global semaphore (a per-upload DB lease would add latency, the very thing we are minimizing).
- **Coalesced cumulative PUT ("partial insert").** Sources are processed in **waves of `concurrency`**: each wave mints concurrently, persists the new tokens, then does **one cumulative `file_token` PUT** of the full set so far. Attachments appear in waves, conflict-free (no two PUTs to one row race — waves are sequential), and a wave-boundary crash leaves the prior waves' files on the row for rearm/sweep to finish. A `filling` status + a per-wave heartbeat (`attachmentNextRetryAt`) keeps an actively-progressing fill from being double-driven while a crashed one goes stale and becomes rearmable.
- **Runtime ownership + freshness guard.** Every `Sales Files` PUT passes `mayUpdateOwnedBitableRow` at **runtime** (not by comment): the row must be one **this flow minted** (`bitableRecordId` present **and** equal to the target, `bitableClientToken` matches) **and fresh** — minted within `BITABLE_OWNED_ROW_UPDATE_WINDOW_MS` (configurable Convex env, default **2 h**, never an inline literal). A foreign or ancient row is **refused** and logged, never written. The fill is kicked from inside `markBitableSyncSucceeded` (the mutation that stamps `bitableRecordId` + `bitableRowMintedAt`) so the guard always sees the committed row. Column scope: only the add-in-owned `Sales Files` — never the Feishu-owned **`Request Type`**.
- **Mail-byte hard gate.** The SPA reads selected mail-attachment bytes off Office.js and stages them to Convex File Storage **before** the row create / before the pane can close — Office.js bytes are unrecoverable once the pane closes. This parallel local stage is the only thing the salesperson waits for.
- **Persist-before-delete.** `upload_all` is **not** idempotent (re-minting yields a fresh `file_token` + new Drive object). The deferred fill persists a minted token to the Email Record **before** deleting its staged blob, so a mid-fill crash replays only the still-un-minted sources.
- **State lives in Convex, not Base.** The owner explicitly declined a Base-visible "uploading…" column; fill progress is tracked only on the Convex Email Record (the taskpane may surface a passive indicator).

## Considered options

- **Defer the CREATE** (the `codex/attachment-sync-latency-reduction` shape: mint all tokens in the worker, *then* create the row carrying them). Rejected: the row does not exist until the slow serial Drive leg finishes, and if Drive stalls there is **no row at all** — losing the salesperson's typed notes / Customer / Coworker, the exact loss ADR-0026's fault-tolerance exists to prevent. Create-now commits the high-value, fast-to-write data atomically and treats only the slow, best-effort Drive leg as deferred.
- **Global Drive-upload budget** (a Convex lease/semaphore bounding total in-flight uploads ≤5). Rejected for now: the per-upload lease round-trip adds latency; the per-fill cap + reset-header retry self-corrects the rare concurrent-fill overlap. Revisit if logs show real `99991400` storms.
- **Base-visible status column.** Rejected by the owner — state stays in Convex.

## Consequences

- A **Base** viewer sees an empty `Sales Files` cell during the fill window (~3 s, longer under retry). Accepted: progress is observable in Convex, and the owner declined a Base marker column.
- The freshness window means a fill that does not complete within it is **permanently given up** — which *is* the "never update an ancient row" rule. It must be surfaced as an observable `failed` state (reason recorded), never a silent gap. The bounded-retry span is kept inside the window so retries don't schedule an attempt the guard will refuse.
- New Email Record fields + the new attachment index; the SPA submit path stops calling Drive `uploadAttachmentsToDrive` (it now passes `attachmentSources` to `syncRequest`); the client Drive action remains only for the correction flow.

## Deferred

- **>20 MB files** keep the existing skip-with-observable-failure; chunked `upload_prepare / upload_part / upload_finish` is a future enhancement.
- A **global Drive budget** across concurrent fills, if `99991400` storms actually appear.
- Received-screen indicator polish (a passive "files attaching… / N could not be attached" affordance).
