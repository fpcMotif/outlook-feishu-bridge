# Convex ↔ external-source sync Glossary

Terminology for keeping a Convex read-model in lockstep with an external system of record (the Feishu Bitable Customer Table).

## Terms

**System of record**:
The authoritative source for an entity. Here, the Feishu Bitable Customer Table — never the Convex mirror.
_Avoid_: "the database", "source" (ambiguous)

**Mirror**:
A Convex read-model that copies a system of record for fast local querying. It is never authoritative and only ever reads its source.
_Avoid_: "cache" (a mirror is full, not eviction-based), "copy"

**Sync key**:
The single field a mirror upserts on — the identity that decides insert-vs-patch and that the reconcile step matches against.
_Avoid_: "primary key" (that's the Convex `_id`), "id" (ambiguous)

**Natural key**:
A sync-key candidate carrying business meaning (email, account no., a `RECORD_ID()` column). Risky: business meaning changes.
_Avoid_: "real id"

**Surrogate key**:
A system-assigned id with no meaning outside its system (Feishu's API `record_id`). Immutable by design — the correct sync key.
_Avoid_: "random id", "internal id"

**"Never changes" test**:
The check for a sync key: if a human can edit it, it's a formula, or it derives from business data, it will eventually change — so don't key on it. Treat "changes once in a blue moon" as "changes".

**Idempotent upsert**:
A write keyed on the sync key that is safe to retry — re-running the sync inserts new rows and patches changed ones but never duplicates.
_Avoid_: "merge", "sync write"

**Reconciliation (Mirror Prune)**:
The delete half of a sync: after a verified-complete pass, remove any mirror row whose sync key was not seen this run. Upsert can't delete; reconciliation is what propagates source deletes.
_Avoid_: "cleanup", "garbage collection"

**Tombstone**:
The act of deleting an orphaned mirror row during reconciliation.
_Avoid_: "soft delete" (here it is a hard delete)

**Mirror drift**:
The mirror's row count diverging from the system of record — caused by an upsert-only mirror (no reconcile) and/or re-keying on a mutable sync key.
_Avoid_: "bug", "overcount" (drift names the mechanism)
