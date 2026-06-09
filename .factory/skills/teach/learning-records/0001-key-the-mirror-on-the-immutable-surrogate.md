# Key the mirror on the system of record's immutable surrogate, not a business column

The user lived through a 3× **mirror drift** incident and asked the precise best-practice question, then saw the fix: a mirror's **sync key** must be the system of record's **surrogate key** (Feishu API `record_id`), never a **natural key** / formula column (`Record Id`) that a human could change. They also grasp that the key only stops *duplication* — a **reconciliation** (prune) is the separate half that stops *drift* from source deletes, and that Convex staleness must use an in-run seen-set, not a timestamp.

Why it matters for next sessions: the floor is set on key choice + the upsert/reconcile pair. Do **not** re-teach these. Natural fits in their zone of proximal development next: (a) the **completeness gate** that makes a delete-pass safe, or (b) the deferred **real-time event sync** (webhook) design — both already named in ADR-0021.

Evidence: drove the full diagnosis, chose the immutable-key + prune fix, authored ADR-0021, and asked specifically about "best practice for the unique key."
