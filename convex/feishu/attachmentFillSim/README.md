# Attachment Fill simulation harness (ADR-0027)

A reusable, in-memory simulation of the **deferred Attachment Fill** server
pipeline. We cannot drive the real Feishu Base, so this harness SIMULATES it (an
in-memory Base + Drive model) and MIMICS the Outlook "send/confirm" intake (a
fixture factory), then runs the **real** Convex handlers end to end against a
faithful in-memory Convex runtime.

It is the load-bearing foundation for the adversarial Attachment Fill suite — the
~7 later test files build on `createHarness()`.

## The owner's #1 invariant (what the suite must keep proving)

When a row is created **and** the intake carried attachment sources, the fill
must:

- **(a)** ALWAYS run (kicked, never silently dropped),
- **(b)** target the SAME row this flow minted (never a foreign/ancient row,
  never any column but `Sales Files`), and
- **(c)** fully pend ALL file tokens — each source ends as a token on the row OR
  is observably skipped; never partial-and-silent, never duplicated.

## What is real vs simulated

| Real (under test) | Simulated / faked |
| --- | --- |
| `requestSync.ts` (`syncRequest`, `processPendingBitableSync`, `fillRowAttachments`, `rearmConversationSync`) | `callFeishu` / `resolveFeishuToken` (→ `FeishuBaseSim`) |
| `bitable.ts` (`createServiceRecord`, `patchRowAttachments`) | `getStorageBytes` (→ `FakeStorage`) |
| `emails.ts` (all fill mutations/queries) | `ctx.db` (→ `FakeDb`), `ctx.scheduler` (→ `FakeScheduler`), `ctx.storage.delete` |
| `drive.ts` (`mintOneStagedSource`, `driveUploadConcurrency`) + the shared `call.ts` `withFeishuRateLimitRetry` | the `internal.*` dispatcher (→ `Registry`) |
| `serviceRow.ts`, `attachmentFill.ts`, `bitableSyncRetry.ts` | — |

> **Do NOT mock** `./drive`, `./bitable`, `../emails`, `./requestSync`,
> `./attachmentFill`, `./serviceRow`, `./bitableSyncRetry`. Only `./call` and
> `../storage` are mocked — those are the I/O boundary.

## The vi.mock seam (copy-paste)

The seam delegates the two mocked modules into the **current test's** harness via
a `vi.hoisted` holder. `vi.mock` is hoisted above imports, so the factory must
reference the hoisted holder (not the harness directly).

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 1. Hoisted holder the mocked modules delegate through.
const mocks = vi.hoisted(() => ({
  callFeishu: async (..._a: unknown[]): Promise<unknown> => {
    throw new Error("harness not wired: callFeishu");
  },
  resolveFeishuToken: async (..._a: unknown[]): Promise<string> => "tenant-token",
  getStorageBytes: async (..._a: unknown[]): Promise<ArrayBuffer> => {
    throw new Error("harness not wired: getStorageBytes");
  },
}));

// 2. Mock ONLY the I/O boundary. Paths are relative to the TEST FILE
//    (convex/feishu/*.test.ts): ./call and ../storage.
vi.mock("./call", () => ({
  callFeishu: (...a: unknown[]) => mocks.callFeishu(...a),
  resolveFeishuToken: (...a: unknown[]) => mocks.resolveFeishuToken(...a),
}));
vi.mock("../storage", () => ({
  getStorageBytes: (...a: unknown[]) => mocks.getStorageBytes(...a),
}));

// 3. Import the harness AFTER the mocks.
import { createHarness, type Harness } from "./attachmentFillSim";

let harness: Harness;
const origApp = process.env.FEISHU_BITABLE_APP_TOKEN;
const origTable = process.env.FEISHU_BITABLE_TABLE_ID;

beforeEach(() => {
  process.env.FEISHU_BITABLE_APP_TOKEN = "appTok";
  process.env.FEISHU_BITABLE_TABLE_ID = "tbl_service";
  vi.useFakeTimers();
  vi.setSystemTime(1_716_500_000_000);
  harness = createHarness();
  harness.wireMocks(mocks as never); // point the holder at THIS harness
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (origApp === undefined) delete process.env.FEISHU_BITABLE_APP_TOKEN;
  else process.env.FEISHU_BITABLE_APP_TOKEN = origApp;
  if (origTable === undefined) delete process.env.FEISHU_BITABLE_TABLE_ID;
  else process.env.FEISHU_BITABLE_TABLE_ID = origTable;
});

it("fills 3 distinct tokens onto the created row", async () => {
  const intake = harness.makeIntake({ attachmentCount: 3 });
  await harness.submit(intake);          // send/confirm => pending + create queued
  await harness.driveToCompletion();     // create -> kick -> fill -> coalesced PUT

  const recordId = harness.feishu.recordIds()[0];
  expect(harness.feishu.salesFilesTokens(recordId)).toHaveLength(3);
  const rec = harness.getByMessageId(intake.internetMessageId)!;
  expect(rec.bitableAttachmentStatus).toBe("filled");
  expect(harness.storage.size()).toBe(0); // staged blobs deleted after persist
});
```

Run a single file (never the full suite):

```
bunx vitest run convex/feishu/<your-file>.test.ts
```

## Public API

### `createHarness(): Harness`

Builds a fresh, isolated harness. The harness clock IS the wall clock
(`Date.now()`), which `vi.useFakeTimers()` / `vi.setSystemTime()` own — so moving
time moves both the SUT's freshness/fence math and the scheduler's due math
together.

### `Harness` — drivers

| Method | What it does |
| --- | --- |
| `wireMocks(mocks)` | Point a hoisted mock holder at this harness (in `beforeEach`). |
| `makeIntake(opts?)` | Build a fresh Outlook intake; stages its attachments into this harness's storage. |
| `submit(intake)` | Run the real `syncRequest` handler. Returns its result; **throws propagate** (it is the public action the SPA awaits). |
| `sendAndSettle(intake)` | `submit` then `driveToCompletion`. |
| `startFill(lookup)` | Kick a fill directly (rearm-style) without the create path. |
| `rearm(userEmail, conversationId)` | Run the real `rearmConversationSync`; returns `{ rearmed }`. Drive the queue afterwards. |
| `runDue()` | Run every job DUE at the present clock, once. |
| `driveToCompletion(opts?)` | Drain the queue to quiescence **without advancing time**. Future-dated retries stay pending. |
| `advanceTimeMs(ms)` | Convenience for the non-fake-timer case. **Under fake timers, call `vi.setSystemTime(now + ms)` first**, then `driveToCompletion()`. |

> **Detached-job isolation.** Scheduled jobs run via `runDue` are isolated like
> real Convex scheduled functions: a throw is **captured** (in
> `DriveResult.errors`), not propagated, and the job may already have
> self-rescheduled before throwing (`processPendingBitableSync` re-throws *after*
> queuing its retry). Assert on `result.errors` to see those failures.

### `Harness` — accessors

| Accessor | Returns |
| --- | --- |
| `getByMessageId(mid)` / `getBySyncKey(key)` | The stored Email Record (deep copy) or `null`. |
| `lookupFor(intake)` | `{ internetMessageId, requestSyncKey }` for a submitted intake. |
| `pendingJobs()` | Currently-queued scheduler jobs (`{ id, dueAt, refName, args }`). |
| `feishu` | The `FeishuBaseSim` (see below). |
| `db` / `storage` / `scheduler` / `registry` / `ctx` | Escape hatches for advanced tests. |

### `FeishuBaseSim` — accessors

| Accessor | Returns |
| --- | --- |
| `recordIds()` | Created record ids, in creation order. |
| `salesFilesTokens(recordId)` | file_tokens in that row's `Sales Files` cell, in cell order (`[]` if unset). |
| `rowFields(recordId)` | Deep copy of the row's fields, or `null`. |
| `createLog` | `{ recordId, clientToken, fields, deduped }[]` — every create (incl. idempotent dedups). |
| `putLog` | `{ recordId, fields, fieldKeys }[]` — every PUT (assert coalescing / wrong-row / column-scope). |
| `uploadLog` | `{ fileName, fileToken }[]` — every Drive mint. |
| `salesFilesPuts()` | PUTs that touched the `Sales Files` column. |
| `putsForRecord(recordId)` | PUTs against one row. |
| `mintedCount()` | Total mints. |
| `mintedTokensFor(fileName)` | Tokens minted for a fileName (**>1 ⇒ double-mint bug**). |
| `uploadConcurrencyPeak` | Highest concurrent upload count observed in a wave. |

### `FeishuBaseSim` — fault-injection knobs (chainable)

| Knob | Effect |
| --- | --- |
| `failCreateOnce(err)` / `failCreateNTimes(n, err)` | Throw on the next 1 / n CREATEs, then succeed. |
| `failPutOnce(err)` | Throw on the next PUT once. |
| `failPutMatching(predicate, err, times?)` | Throw on PUTs matching `predicate(opts, fields)` up to `times` (default ∞). |
| `setClientSearchResult(items)` | Customer-table domain-search result (default `[]` ⇒ null Client). |
| `failUploadFor(fileName, {times?, code?})` | Fail that file's upload `times` (default 1) with `code` (default a non-rate-limit `FeishuError` ⇒ the fill **defers** it). |
| `deferUploadFor(fileName, {times?})` | Throw a transient (non-Feishu) error `times` ⇒ the fill classifies it **deferred** (kept for retry). |
| `rateLimitNextUpload(times?)` | Throw `99991400` on the next `times` uploads, then succeed (assert `withFeishuRateLimitRetry` recovers). |
| `setUploadConcurrencyCap(cap)` | Concurrent-upload count above which `99991400` trips (default 5 = the live 5-QPS budget). |
| `gateUploads()` → `{ release }` | Hold ALL uploads mid-flight until `release()`. Start two fills, wait until both have read state + entered upload, then release — exercises the double-mint race. |

### `FakeDb` contracts reproduced exactly

- `patch(id, partial)` is a **shallow merge**, and `value === undefined` **deletes**
  that field (the SUT's next-retry / heartbeat sentinel).
- `insert` assigns a unique `_id` + numeric `_creationTime`, stores a deep copy.
- The five `emailRecords` indexes with `.eq` / `.gte` / `.lte` / `.first` /
  `.take` / `.order('desc')`.
- **"undefined sorts below all numbers"**: `.gte(0)` EXCLUDES rows whose indexed
  field is undefined (defeats the perpetual-due footgun the SUT guards against).

### Fixture factory (`outlookIntake.ts`)

- `makeIntake(storage, { attachmentCount?, bytesPerAttachment?, fileNames?, overrides? })`
  — unique conversation/message ids per call; stages blobs with unique
  bytes/fileNames/storageIds into `attachmentSources`.
- `DEFAULT_COWORKER` / `DEFAULT_SALES` — real (non dev-preview) open_ids that pass
  `poisonedOutboxReason` / `assertRealCoworkerOpenIds`. Use a dev-preview id
  (e.g. `ou_jenny`) or `conversationId: "dev-sample"` to test the poison/abandon
  path.
- `makeBytes(len, seed)` — deterministic ArrayBuffer (use `len >
  20*1024*1024` for the oversize-skip path).

## Gotchas for later agents

- **Fake timers + Drive backoff.** `withFeishuRateLimitRetry` sleeps via
  `setTimeout`. Under `vi.useFakeTimers()`, advance with
  `vi.advanceTimersByTimeAsync(...)` (or `vi.runAllTimersAsync()`) so the backoff
  fires; otherwise a `rateLimitNextUpload` storm stalls inside the retry wrapper.
  Microtask yields (the concurrency model) flush fine under fake timers.
- **Releasing a future-dated retry.** `driveToCompletion` does NOT advance time.
  To run a scheduled retry, `vi.setSystemTime(harness.pendingJobs()[0].dueAt + 1)`
  then `driveToCompletion()`.
- **`uploadConcurrencyPeak`** reflects the true wave width even without a gate
  (the sim yields a microtask inside the in-flight window). Default fill wave =
  `driveUploadConcurrency()` = 4 (cap 5); override via
  `FEISHU_DRIVE_UPLOAD_CONCURRENCY`.
- **Suspected real defect (characterize, don't paper over):** attachment retries
  land at +5/+15/+60/+60 min (~140 min cumulative), but the default freshness
  window (`mayUpdateOwnedBitableRow`) is 120 min — a late retry PUT is **refused**
  by the fence (`patchRowAttachments` throws). Shrink the window with
  `BITABLE_OWNED_ROW_UPDATE_WINDOW_MS` to reproduce it deterministically.
- **Legacy double-attachment risk:** `attachmentSources` (filled after) and the
  legacy `attachments` (written on create) have no mutual-exclusion guard. An
  intake carrying both writes the attachment twice. Characterize, don't fix here.
```
