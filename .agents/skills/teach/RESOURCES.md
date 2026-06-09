# Convex ↔ external-source sync Resources

## Knowledge

- [Agile Data — "Choosing a Primary Key: Natural or Surrogate?" (Scott Ambler)](https://agiledata.org/essays/keys.html)
  The canonical treatment of natural vs surrogate keys, the "smart key" anti-pattern, and keeping the source system's key as an *alternate* key. Use for: the principle behind why an immutable surrogate beats a business-meaningful column.
- [Baeldung — "Natural vs. Surrogate Keys in Database"](https://www.baeldung.com/sql/keys-natural-vs-surrogate)
  Short, concrete comparison incl. the "immutable business identifiers usually aren't" warning (the email-as-PK cautionary tale). Use for: the "never changes" test.
- [Convex Developer Hub — Best Practices](https://docs.convex.dev/understanding/best-practices/)
  Official. Covers the reactivity caveat: queries don't re-run on `Date.now()`, so staleness must come from data, not the clock. Use for: why the prune uses an in-run seen-set, not `mirroredAt`.
- [Convex — Reading & Writing Data / Indexes](https://docs.convex.dev/database/reading-data) · [Pagination](https://docs.convex.dev/database/pagination) · [Limits](https://docs.convex.dev/production/state/limits)
  Official. Index-before-insert upsert, paginated bulk scan/delete, per-transaction write budget. Use for: implementing the upsert + prune loop.
- [Start Data Engineering — "How to make data pipelines idempotent"](https://www.startdataengineering.com/post/why-how-idempotent-data-pipeline/)
  The delete-write / reconciliation patterns and the generation-marker idea. Use for: the reconcile-stale-rows half of the pair.
- **In-repo:** `docs/adr/0021-customer-mirror-prune-and-event-sync.md` + `convex/feishu/customersMirror.ts` + `customers.ts`
  Your own decision record and implementation of exactly this pattern. Use for: grounding every lesson in real code you own.

## Wisdom (Communities)

- [Convex Discord](https://convex.dev/community)
  Official, well-moderated, Convex team answers sync/upsert questions directly. Use for: "is this the idiomatic Convex way to reconcile a mirror?"
- [r/Database](https://www.reddit.com/r/Database/)
  Use for: key-design critique that isn't Convex-specific (natural vs surrogate trade-offs).

## Gaps
- No single official "Convex mirror an external table" guide exists yet; the pattern is assembled from the indexes + pagination + best-practices pages. If the Convex team publishes one, replace the assembled set above.
