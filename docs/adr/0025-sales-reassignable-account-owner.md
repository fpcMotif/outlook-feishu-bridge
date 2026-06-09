# Sales is a reassignable account-owner field (supersedes ADR-0014's "no picker")

> **Status: accepted.** Supersedes the "no picker / `Sales` = the clicker" stance of [ADR-0014](0014-write-initiator-and-subject-to-service-row.md). ADR-0014's other decisions still hold: `创建人` is the bot not the human, and a dedicated `Sales` User column records the human.

## Context

ADR-0014 wrote the Base `Sales` (User) column with the signed-in clicker's `open_id` and explicitly **rejected a picker** for it — *"the Initiator is, by definition, whoever clicked Sync. A picker just lets people misattribute the row."* Since then the intake grew a **Sales picker**: Sales still defaults to the clicker, but can be reassigned to any Feishu user. The real need is a salesperson triaging an inbound client email who hands the request to the colleague who **owns that Customer account**. Because the unit of work is the conversation (one Base row per thread), Sales is **conversation-scoped** — a reassignment persists across sibling messages and resets to the clicker only when the intake moves to a different conversation (via the pinned-pane key remount). An earlier per-message reset was rejected: it silently discarded a deliberate reassignment when the salesperson read a reply before syncing.

## Decision

Sales is a **reassignable** field. Three identities now exist and must not be conflated:

1. **Creator (`创建人`)** — the **Feishu app** (tenant bot, `bitable:app`); automatic; never a human.
2. **Initiator** — the human who clicked **Sync** (the signed-in user); the *default* of Sales and the intended audit of *who* synced.
3. **Sales** — the Base `Sales` column; defaults to the Initiator, reassignable to a **Coworker**; **conversation-scoped** — persists across sibling messages in a thread and resets to the Initiator only when the intake moves to a different conversation.

## Consequences

- On a conversation switch the revert to the Initiator is applied **immediately**; the 2.5s "Pick a sale" onboarding pause (`SALES_DEFAULT_DELAY_MS`) is a **first-load-only** affordance, gated by a module-global flag in `scheduleSalesDefault` (reset between tests via `resetSalesDefaultForTests`).

## Deferred (埋下伏笔)

When Sales is reassigned (**Sales ≠ Initiator**), should the **Email Record**'s `initiator` audit record (a) the actual *clicker*, or (b) the reassigned *Sales*? Today `buildSyncPayload` feeds `state.selectedSales ?? user` into **both** the Base `Sales` column **and** the Email Record `initiator`, so the audit currently follows the reassignment (records the colleague). The intended direction is **(a) record the clicker**, but this is **deferred** until the reassignment case is actually exercised in the field. Resolve at `src/components/taskpane/buildSyncPayload.ts` (the `initiator:` line) when the decision is made — no code change now.
