# Request sync uses a Convex outbox plus scheduled Feishu Base reconcile

> **Status: accepted.** Extends [ADR-0010](0010-pivot-to-bitable-intake.md), [ADR-0012](0012-bitable-record-api.md), and [ADR-0016](0016-customer-search-modes-and-observability.md).

The app has two separate sync loops:

- **Customer directory:** Feishu Base Customer Table -> Convex mirror. This remains a weekly full sync plus on-demand cache-miss backfill. Feishu is the source of truth and Convex is the search mirror.
- **Request intake:** Outlook taskpane -> Convex Email Record backup -> Feishu Base Service row. The Base row is still the operational record, but Convex must not miss a request when a network or runtime failure lands between systems.

## Decision

Request intake writes a durable Convex Email Record before the Feishu create call:

1. `requestSync.syncRequest` validates exactly one coworker.
2. It creates or updates an `emailRecords` backup with `sentToBitable=false`, `bitableSyncStatus="pending"`, and a stored Feishu `bitableClientToken`.
3. It schedules `processPendingBitableSync` (delay 0) and returns `{ status: "pending" }` unless the outbox already has a `bitableRecordId` (idempotent hit).
4. `processPendingBitableSync` calls `bitable.createServiceRecord` with that token as Feishu `client_token`, making retries idempotent.
5. On success it patches the Email Record with `bitableRecordId`, `sentToBitable=true`, and `bitableSyncStatus="synced"`.
6. On create failure it marks the backup `failed` and schedules retry with bounded backoff.
7. A Convex cron runs every 15 minutes and replays due `pending` / `failed` backups in batches of 20 using the same stored `client_token`.

The taskpane subscribes to `getBitableSyncByConversation` and leaves the sync screen when the outbox becomes `synced` — it does not require `recordId` on the immediate `syncRequest` response.

Backoff is 5 minutes after the first failure, 15 minutes after the second, then 60 minutes for later failures. The 15-minute cron cadence is short enough to catch missed requests without turning Feishu Base into a constant polling dependency.

## Failure Model

- If Convex cannot write the pending backup, no Feishu row is created. The UI shows a sync failure and the user can retry.
- If Feishu create fails, the pending backup remains in Convex and the cron retries.
- If Feishu creates the row but Convex cannot mark it synced, the pending backup is retried later with the same `client_token`, so Feishu should return the same create result instead of duplicating the row; the UI learns `bitableRecordId` when the outbox subscription flips to `synced`.
- Existing no-touch rules remain: the add-in creates a new Service row and may only correction-update the row just created in the current session.

## Consequences

- `emailRecords` now also acts as the request-sync outbox.
- `crons.ts` has two sync schedules: weekly customer mirror refresh and 15-minute request outbox reconcile.
- The customer mirror remains read-only against the Customer Table; this ADR does not add Base webhooks or historical Service-row pull audit.

## Amendment: first-attempt lease (accepted)

The original step 2 set `bitableNextRetryAt = now`, which left a freshly-enqueued
row immediately "due". The immediate `processPendingBitableSync` worker and the
15-minute reconcile cron could therefore both pick up the same row and call
Feishu create in parallel. The stored `client_token` makes that **correct**
(Feishu dedupes), but it is wasteful and races the success mark.

`beginBitableSync` now parks `bitableNextRetryAt` a short **first-attempt lease**
(`BITABLE_SYNC_FIRST_ATTEMPT_LEASE_MS`, ~2 min) ahead whenever it schedules an
immediate worker, so the cron does not claim a row that worker already owns. The
lease is much longer than a single create (seconds) yet short enough that a
genuinely dropped scheduled job is reclaimed promptly. The decision is a pure
helper, `planBitableSyncBegin` (`convex/feishu/bitableSyncRetry.ts`), unit-tested
per the extract-then-test seam ([ADR-0019](0019-extract-then-test-seam.md)). On a
create failure the normal backoff (5 / 15 / 60 min) overrides the lease, so it
never delays a legitimate retry — it only suppresses the redundant double-fire
during the first in-flight attempt.

## Future Work

- Add a read-only daily Service-row audit from Feishu to Convex once the Base schema has enough stable join fields to reconstruct or classify missing backups.
- Replace scheduled retry with Feishu webhooks if the tenant admin enables a supported Base webhook receiver.
