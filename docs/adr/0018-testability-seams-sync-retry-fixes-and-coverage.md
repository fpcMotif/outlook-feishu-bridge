# Testability seams, Bitable-Sync retry fixes, and a coverage policy

> **Status: accepted.** A consolidation + hardening pass over the **Bitable Sync** / **Self-Forward** paths ([ADR-0012](0012-bitable-record-api.md), [ADR-0017](0017-graph-self-forward-note-to-myself.md)). No new product behavior; it removes duplicate-row hazards, closes a reflected-XSS hole on the **Fallback OAuth Callback**, stops leaking PII into logs, deletes dead code, and lifts the test-coverage floor by extracting pure seams. Amends [ADR-0017](0017-graph-self-forward-note-to-myself.md): the EWS→REST id conversion now lives in `src/office/mailItem.ts`, not inside `useMailItem.ts`.

## Context

A read-only review of the sync/self-forward flow surfaced six verified defects (four clustered in `RequestIntakeScreen.tsx`) plus a set of consolidation/testability opportunities. Coverage sat at ~40%, concentrated in untested hooks, the Office seam, and Convex wrappers. The codebase already had a clean extract-then-test discipline (`serviceRow.ts`, `selfForwardChain.ts`, `feishuFetch`); this ADR extends it rather than introducing a new test framework.

## Decision — bug fixes

1. **No duplicate Service row on Bitable retry.** The error-screen "Try again" re-ran `syncRequest`, which always `createServiceRecord`s a new row. Two changes close this:
   - **Backend (authoritative-write resilience):** `requestSync.syncRequest` now treats the **Email Record** as the recoverable BACKUP it is (CONTEXT.md). A `storeEmailRecord` failure is caught and logged, and the created `recordId` is still returned — so a created Bitable row never throws the client into a duplicate-creating retry.
   - **Client (sanctioned correction path):** the SPA captures the returned `bitableRecordId` in reducer state and, on any subsequent run, calls `correctRequest` (the in-place PUT bounded to the row this flow created, [ADR-0012](0012-bitable-record-api.md)) instead of `syncRequest`. This wires up the previously-dead `correct` stack and respects the no-touch HARD RULE.
2. **No duplicate Self-Forward on Bitable retry.** `runSync` only fires the Self-Forward when `selfForwardStatus !== 'ok'`; the Graph forward is non-idempotent, and the dedicated re-fire path is the ReceivedScreen retry chip ([ADR-0017](0017-graph-self-forward-note-to-myself.md)).
3. **No stale-flow clobber.** A monotonic `generationRef` tags each `runSync` / Start Over. A Self-Forward resolving late from a previous flow compares its captured generation and skips its dispatch, so it cannot flip a freshly-reset chip.
4. **In-flight feedback on Self-Forward retry.** `fireSelfForward` now dispatches `selfForwardStarted` before awaiting, activating the previously-dead `pending` reducer branch ("Sending Note to myself…").
5. **Reflected XSS on the Fallback OAuth Callback** (`server/feishu-auth/index.ts`). The attacker-controllable `state` flowed into an inline `<script>` via `JSON.stringify`, which does not escape `<`/`>`/`/`, so `</script>…` broke out on the token hand-back path. Fixed by (a) `\uXXXX`-escaping `< > & U+2028 U+2029` when embedding the message — a transform that round-trips to the identical JSON the SPA parses — and (b) validating `state` is a `crypto.randomUUID()` shape before reflecting it.
6. **No PII in Bitable create logs.** `createServiceRecord` logged the full intake (client email, salesperson + coworker identities, free-text notes) and resolved fields on every create. It now emits a redacted summary (counts, field keys, lengths); the verbose dump is gated behind `BITABLE_DIAG_LOG=1`, matching the m365 chain's deliberate redaction.

## Decision — consolidation & testability seams

- **`intakeReducer.ts`** extracts the `IntakeState`/`IntakeAction` types, `initialIntakeState`, and `intakeReducer` from `RequestIntakeScreen.tsx`, so the orchestration state machine is unit-tested without rendering React.
- **`mailItem.ts`** extracts the pure Office.js→`MailItemData` mappers (`extractMailData`, `convertToRestId`, `isComposeItem`, `emailList`) from `useMailItem.ts`, taking the Office handle as a parameter (the `selfForwardChain`-style injection seam). `MailItemData` is re-exported from `useMailItem.ts` so existing imports keep working.
- **Validator dedupe:** `bitable.ts` imports `requestSelectionValidator` / `selectedCoworkerValidator` / `initiatorValidator` from `emailRecord.ts` (the documented single source of truth) instead of forking identical copies.
- **`emailDomain` dedupe:** `bitable.ts` imports the exported `emailDomain` from `customers.ts`, collapsing a triplicated helper and removing a divergent trailing-`@` guard (`bitable`'s copy treated `"x@"` as domain `""`).

## Decision — dead code removed (per the standing remove-dead-code rule)

- `readMailBodyHtml` (`mailBody.ts`) — no production caller.
- The attachment machinery (`AttachmentInfo`, `extractAttachments`, `MailItemData.attachments`) — populated and logged but consumed nowhere; attachments are retired ([ADR-0010](0010-pivot-to-bitable-intake.md)).
- The four `diag*` `internalAction`s in `bitable.ts` — one-off 1255001/DuplexLink post-mortem probes.

`mailCategory.ts` is **kept** — CONTEXT.md marks the Outlook category as "planned but deferred." `convex/returns.ts` is **kept but excluded from coverage** — it has no live caller and is a deletion candidate, but removing it is a Convex schema/backend change deferred to its own ADR.

## Decision — coverage policy

- Coverage runs via `@vitest/coverage-v8` (`bun run test:coverage`), `include: src/** + convex/**`.
- `exclude` (with justification) covers code with no meaningful, framework-free unit test: `_generated/**`, `*.d.ts`, declarative `schema.ts` / `crons.ts`, bootstrap `main.tsx`, type-only/static modules (`requests.ts`, `coworkers.ts`), and Convex function wrappers whose only uncovered lines are `ctx.run*` glue requiring a live runtime (`emails.ts`, `returns.ts`, and the residual action handlers whose pure logic is extracted and tested separately).
- We deliberately do **not** add `convex-test`; pure logic is extracted and tested directly, matching the codebase's established pattern.

## Consequences

- `RequestIntakeScreen.tsx` shrinks below the file-length threshold; the reducer is independently tested (`intakeReducer.test.ts`) and the orchestration bugs have regression tests (`RequestIntakeScreen.bugfix.test.tsx`).
- The Self-Forward EWS→REST conversion is now unit-tested (`mailItem.test.ts`), closing the gap [ADR-0017](0017-graph-self-forward-note-to-myself.md) left.
- `correctRequest` is no longer dead; it backs the retry-in-place path.
- Logs no longer carry customer/salesperson PII by default.

## References

- Feishu Bitable record create/update (no-touch rule): https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/update
- Graph `message: forward` (non-idempotent send): https://learn.microsoft.com/graph/api/message-forward
- OWASP — XSS in inline scripts / JSON in HTML: https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
- Office.js `convertToRestId`: https://learn.microsoft.com/javascript/api/outlook/office.mailbox#outlook-office-mailbox-converttorestid-member
