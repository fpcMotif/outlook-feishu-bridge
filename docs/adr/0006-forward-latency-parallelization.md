# Cut Outlook→Feishu forward latency by parallelizing the pipeline

> **Status: superseded by [ADR-0010](0010-pivot-to-bitable-intake.md).** Historical — the multi-target forward dispatch this parallelizes is retired in the Base-intake pivot (a single Base write remains); kept for context.

Forwarding an email to Feishu ran the whole pipeline in series: generate the
PDF, then upload each attachment one-by-one, then create the Feishu Doc, then
send the card + PDF + each attachment message sequentially, per target. On a
China→US (Convex)→Feishu path every hop is a fat round-trip, so the wall-clock
the user feels after clicking **Forward** was roughly the *sum* of every
segment. We restructured the pipeline so independent work overlaps.

## Decision

Run independent work concurrently; keep only the ordering Feishu genuinely
requires.

- **Client orchestration** ([`src/forward/forwardEmail.ts`](../../src/forward/forwardEmail.ts)):
  the PDF, attachment-upload, and Feishu-Doc branches now run under one
  `Promise.all`, and attachments upload concurrently (`Promise.all(map)`) instead
  of a sequential `for` loop. `attachmentFileKeys` order is preserved because
  `Promise.all` keeps input order regardless of completion order. Inside the Doc
  branch, Markdown conversion and media staging also overlap.
- **Server send** ([`convex/feishu/message.ts`](../../convex/feishu/message.ts)):
  `sendEmailMessage` awaits the interactive **card first** (it must land before
  its follow-ups), then fires the PDF + attachment messages concurrently.
- **Target fan-out** ([`convex/feishu/forwardEmail.ts`](../../convex/feishu/forwardEmail.ts)):
  `dispatchToTargets` sends to the independent receivers (bot, team chat,
  Base, contacts, groups) concurrently rather than in series.

The only preserved ordering is **card-before-follow-ups per receiver** (asserted
by a unit test in `message.test.ts`). Cross-receiver and follow-up-vs-follow-up
ordering is irrelevant and now races.

## Measurement

Real proof must come from an actual Outlook forward — the on-screen DebugPanel
`dlog()`/`dtime()` segment timings plus the `[forward.send]` / `[feishu]` /
`[storage]` durations in `bunx convex logs`. The app is instrumented for exactly
that (button-click → done `T_total`, and each segment).

Because this checkout has no Outlook/Feishu fixture, we also model the
orchestration critical path deterministically with
[`scripts/forwardLatencyBench.ts`](../../scripts/forwardLatencyBench.ts): it
drives the **real** `forwardEmail` with fake Office/Convex/Feishu deps on a
virtual clock (load-independent), using China-network delay estimates. The
"sequential" column is the serial sum of segment delays (== the old pipeline's
wall-clock, validated by running the pre-change code); "concurrent" is the
measured critical path of the new code.

| case (synthetic model)      | sequential | concurrent | reduction |
| --------------------------- | ---------- | ---------- | --------- |
| A — 1–2 pages, no attach.   | 1250 ms    | 1250 ms    | 0%        |
| B — +2 attachments (5 MB)   | 5815 ms    | 4180 ms    | 28%       |
| B — +attachments +Feishu Doc| 10410 ms   | 4965 ms    | **52%**   |

These are model numbers (estimates), not delivery proof. They show the shape of
the win: Case B with a Doc — the heaviest path and the primary metric — clears
the ≥50% target, and Case A is already well under the ~2 s "near-instant" bar.

## Consequences

- **The 5 MB attachment is the floor for Case B (no doc).** One file's own
  read → stage-to-storage → Feishu-upload chain is genuinely sequential (each
  step needs the previous), and the China uplink of 5 MB dominates. Concurrency
  overlaps *everything else* with it, but cannot shrink it; that is why Case B
  without a Doc lands at ~28%, not 50%. Honoring the [ADR-0004](0004-binaries-cross-via-convex-file-storage.md)
  storage-staging invariant (CN→Convex, then Convex→Feishu) is a deliberate
  double-hop we keep for correctness/size-safety.
- **`docCreate` is now the Case-B-with-Doc bottleneck** (~3.3 s of the model):
  the Feishu Doc create + per-block + per-media drive-upload calls are
  inherently sequential server-side calls. Overlapping the Doc branch with the
  attachment branch is what delivers the 52%; squeezing `docCreate` itself would
  need Feishu-side batching that the API does not offer today.
- **Failure semantics changed slightly.** With `Promise.all`, if one branch
  throws the others are abandoned (an unhandled rejection still rejects the
  whole forward, as before). Per-attachment doc staging stays best-effort
  (errors swallowed per item) so one bad attachment can't abort the Doc.
- **Ordering guarantee is now explicit + tested.** "Card first" used to be an
  implicit consequence of sequential `await`s; it is now an intentional contract
  with a regression test.
