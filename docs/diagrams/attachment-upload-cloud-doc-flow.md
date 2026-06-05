# Attachments → cloud doc (Feishu Drive) upload flow — UX latency optimization

Illustrates the [ADR-0022](../adr/0022-attachments-and-mail-body-to-base-row.md)
amendment: the Drive `medias/upload_all` (“upload all attachments to the cloud
doc”) moved **off the submit critical path** into the deferred Base-write worker,
so the taskpane flips to **“Syncing…” instantly** instead of blocking on the
serial 5 QPS Drive uploads.

## After — end-to-end in the backend (improved UX)

```mermaid
sequenceDiagram
    autonumber
    actor U as Salesperson
    participant SPA as Taskpane (SPA)
    participant CS as Convex File Storage
    participant SR as Convex · syncRequest + outbox
    participant W as Convex · deferred worker<br/>processPendingBitableSync
    participant DR as Feishu Drive<br/>medias/upload_all (cloud doc)
    participant BT as Feishu Bitable

    U->>SPA: Click "Sync"
    Note over SPA: Office.js downloads checked mail<br/>attachments + collects uploads

    par For every selected file (parallel · no QPS cap)
        SPA->>CS: POST bytes (generateUploadUrl)
        CS-->>SPA: storageId
    end

    SPA->>SR: syncRequest({ ...payload,<br/>attachmentSources:[{ storageId, fileName }] })
    SR->>SR: beginBitableSync (outbox, mint client_token)
    SR-->>SPA: { status: "pending" }
    rect rgb(225, 245, 230)
    Note over U,SPA: ✅ UI flips to "Syncing…" INSTANTLY<br/>(no longer waits on Drive)
    end
    SR-)W: scheduler.runAfter(0)

    Note over W,BT: upload_all → create runs server-side,<br/>off the submit critical path
    loop each attachment (SERIAL · 5 QPS · exp. backoff)
        W->>DR: upload_all (parent_type=bitable_file, tenant token)
        DR-->>W: file_token
        W->>CS: delete staged object
    end
    W->>BT: create row (file_tokens + client_token, idempotent)
    BT-->>W: record_id
    W->>SR: markBitableSyncSucceeded

    SR-->>SPA: live query (getBitableSyncByConversation) → "synced"
    SPA-->>U: ✅ "Synced" screen + Base record link
```

## Before — SPA blocked on serial Drive uploads (slow UX)

```mermaid
sequenceDiagram
    autonumber
    actor U as Salesperson
    participant SPA as Taskpane (SPA)
    participant CS as Convex File Storage
    participant DA as uploadAttachmentsToDrive (action)
    participant DR as Feishu Drive
    participant SR as syncRequest (action)

    U->>SPA: Click "Sync"
    par stage bytes
        SPA->>CS: POST bytes
        CS-->>SPA: storageId
    end

    rect rgb(252, 226, 226)
    Note over SPA,DR: ⛔ SPA BLOCKS here on the serial Drive uploads
    SPA->>DA: uploadAttachmentsToDrive(sources)
    loop each attachment (SERIAL · 5 QPS)
        DA->>DR: upload_all
        DR-->>DA: file_token
    end
    DA-->>SPA: file_tokens
    end

    SPA->>SR: syncRequest({ ...payload, attachments:[{ file_token }] })
    SR-->>SPA: pending
    Note over U,SPA: ⚠️ "Syncing…" appears only AFTER every upload finishes
```

## Worker decision logic — `resolveSyncAttachments` (current — shipped)

```mermaid
flowchart TD
    A[Deferred worker starts<br/>processPendingBitableSync] --> B{attachmentSources<br/>present?}
    B -- "yes (new submit path)" --> C[uploadStagedSourcesToDrive<br/>resolve 1 tenant token, reuse]
    C --> D[for each file: upload_all → file_token<br/>SERIAL · 5 QPS · backoff · delete staged]
    D --> E[attachments = minted file_tokens]
    B -- "no (correction / legacy)" --> F[attachments = pre-minted tokens]
    E --> G[createServiceRecord<br/>fields + Sales Files cell + client_token]
    F --> G
    G --> H{create ok?}
    H -- yes --> I[markBitableSyncSucceeded<br/>live query → 'synced']
    H -- no --> J["⚠️ markBitableSyncFailed → reconcile<br/>rebuilds from Email Record:<br/>no sources ⇒ row WITHOUT attachments<br/>(SILENT DROP — known issue #55)"]
```

> ⚠️ **Known issue (#55):** the highlighted `J` branch is a *silent degraded success* — a Drive-upload failure ends with a bare row and a green "Synced". The proposed fix below replaces it with a hard `needs_attachment_recovery` state.

## Corrected logic — no-bare-row invariant (PROPOSED, #55 — not yet implemented)

```mermaid
flowchart TD
    A[worker / reconcile<br/>load persisted manifest + tokens + client_token] --> B{all expected attachments<br/>resolvable?<br/>valid token OR re-mintable bytes}
    B -- yes --> C[validate token provenance<br/>tenant + app_token, re-mint on mismatch]
    C --> D[createServiceRecord<br/>Sales Files = file_tokens + client_token]
    D --> E[mark succeeded · delete staged bytes]
    B -- no --> F["needs_attachment_recovery<br/>DO NOT create the row"]
    F --> G[retry w/ same client_token + saved tokens,<br/>or surface to user]
```

## Why the UX improves

- **Instant feedback:** `syncRequest` returns `pending` the moment the outbox row
  exists, so the taskpane shows “Syncing…” immediately instead of after the last
  Drive upload.
- **One fewer client round trip:** the SPA no longer calls
  `uploadAttachmentsToDrive` then `syncRequest` — it stages bytes once and makes a
  single `syncRequest` call carrying `attachmentSources`.
- **Slow work moved server-side:** the 5 QPS serial `upload_all` + the Bitable
  create now run together in the background worker (warm tenant token), not on the
  user’s click path.
- **Same guarantees:** tokens are still minted *before* the create, the worker is
  scheduled exactly once (`beginBitableSync`), so the create stays idempotent and
  there are no duplicate uploads.
