# Submit dock sync gate

The bottom **Sync** dock on the request intake screen stays disabled until the
user has completed every prerequisite. Partial progress (two of three) never
enables the button.

## Prerequisites

| # | Requirement | How the UI satisfies it |
| --- | --- | --- |
| 1 | **Customer** | A row is chosen in the customer picker (`selectedCustomer` is set), including auto-match from the client email. |
| 2 | **Coworker** | Exactly one Feishu coworker is selected on the cards. |
| 3 | **Request** | At least one of Quotation, Sample, or R&D Support has a **non-empty trimmed note**. Opening a card without typing does not count. |

Logic lives in `submitSyncGate.ts` (`canSubmitSync`, `submitSyncHint`) and is
wired from `RequestIntakeScreen.tsx` into `SubmitDock` as `canSubmit` /
`data-live`.

## Disabled hint copy

When disabled, the dock shows the first missing item in top-to-bottom screen order:

1. No customer → “Select a customer”
2. No coworker → “Choose exactly one Feishu coworker”
3. No fulfilled request → “Start a request below”

When all three are met, the primary label replaces the hint (e.g. “Sync with …”).

## State diagram

```mermaid
stateDiagram-v2
  direction LR
  [*] --> Disabled
  state Disabled {
    [*] --> CheckCustomer
    CheckCustomer --> HintNoCustomer: no customer
    CheckCustomer --> CheckCoworker: customer ok
    CheckCoworker --> HintNoCoworker: no coworker
    CheckCoworker --> CheckRequest: coworker ok
    CheckRequest --> HintNoRequest: count = 0
  }
  Disabled --> Live: customer ∧ coworker ∧ fulfilled ≥ 1
  Live --> Disabled: any requirement cleared
  Live --> Submitting: tap Sync
  Submitting --> Live: send idle
```

## Visual states (`SubmitDock`)

- **Live:** primary fill, `shadow-float`, hover lift, `active:scale-[0.96]`, arrow icon when `count > 0`.
- **Disabled:** muted fill, no float shadow, `cursor-not-allowed`, no press scale (`disabled` + no `data-live`).
