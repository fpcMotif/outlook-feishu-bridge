# Request sync uses a Convex outbox plus scheduled Feishu Base reconcile

> **Status: accepted.** Extends [ADR-0010](0010-pivot-to-bitable-intake.md), [ADR-0012](0012-bitable-record-api.md), and [ADR-0016](0016-customer-search-modes-and-observability.md).

The app has two separate sync loops:

- **Customer directory:** Feishu Base Customer Table -> Convex mirror. This remains a weekly full sync plus on-demand cache-miss backfill. Feishu is the source of truth and Convex is the search mirror.
- **Request intake:** Outlook taskpane -> Convex Email Record backup -> Feishu Base Service row. The Base row is still the operational record, but Convex must not miss a request when a network or runtime failure lands between systems.

## Decision

Request intake writes a durable Convex Email Record before the Feishu create call:

1. `requestSync.syncRequest` validates exactly one coworker.
2. It creates or updates an `emailRecords` backup with `sentToBitable=false`, `bitableSyncStatus="pending"`, and a stored Feishu `bitableClientToken`.
3. It calls `bitable.createServiceRecord` with that token as Feishu `client_token`, making retries idempotent.
4. On success it patches the Email Record with `bitableRecordId`, `sentToBitable=true`, and `bitableSyncStatus="synced"`.
5. On create failure it marks the backup `failed` and schedules retry with bounded backoff.
6. A Convex cron runs every 15 minutes and replays due `pending` / `failed` backups in batches of 20 using the same stored `client_token`.

Backoff is 5 minutes after the first failure, 15 minutes after the second, then 60 minutes for later failures. The 15-minute cron cadence is short enough to catch missed requests without turning Feishu Base into a constant polling dependency.

## Failure Model

- If Convex cannot write the pending backup, no Feishu row is created. The UI shows a sync failure and the user can retry.
- If Feishu create fails, the pending backup remains in Convex and the cron retries.
- If Feishu creates the row but Convex cannot mark it synced, the UI still receives the Base record id. The pending backup is retried later with the same `client_token`, so Feishu should return the same create result instead of duplicating the row.
- Existing no-touch rules remain: the add-in creates a new Service row and may only correction-update the row just created in the current session.

## Consequences

- `emailRecords` now also acts as the request-sync outbox.
- `crons.ts` has two sync schedules: weekly customer mirror refresh and 15-minute request outbox reconcile.
- The customer mirror remains read-only against the Customer Table; this ADR does not add Base webhooks or historical Service-row pull audit.

## Future Work

- Add a read-only daily Service-row audit from Feishu to Convex once the Base schema has enough stable join fields to reconstruct or classify missing backups.
- Replace scheduled retry with Feishu webhooks if the tenant admin enables a supported Base webhook receiver.
