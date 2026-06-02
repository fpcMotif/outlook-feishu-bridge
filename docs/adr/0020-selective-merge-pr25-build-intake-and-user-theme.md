# Selective merge of PR #25: take the build/intake redesign + a user-facing theme, keep the existing-sync reconcile UX

> **Status: accepted.** Extends [ADR-0013](0013-customer-directory-preload-and-picker.md), [ADR-0016](0016-customer-search-modes-and-observability.md), and [ADR-0018](0018-request-sync-outbox-and-reconcile.md). Concerns the SPA taskpane only; no Convex/backend change.

PR #25 (`feat/spa-ui-pass-2`, "second-pass SPA taskpane polish", +992/-227 across 32 files) was raised against an older `main` and went **CONFLICTING** as `main` advanced (CoworkerPicker decomposition `a6ab7e0`, request-copy/sync-routing `f650027`). Rather than merge it wholesale, we re-apply a chosen subset onto current `main`.

The PR is frontend-only — it touches no `convex/` file — so the **Convex Backend** keeps `main`'s approach unconditionally.

## Decision

We take **three things** from PR #25 and keep `main` for everything else.

**Take (build/intake page):** the `RequestIntakeScreen` visual layer — `IntakeHeader`, the footer-less `SubmitDock` driven by the new `submitSyncGate` module, `RequestCards`, `CustomerPicker`/`CoworkerPicker` rows via the shared `TaskpaneSelectionRow`, and `icons/CoworkerIcon`. The PR's monolithic `CoworkerPicker` (which ships `eslint-disable max-lines`) replaces `main`'s `coworker-picker/` submodule **only because the prop contract changed** (`selectedOpenId` → `selectedCoworker`); the orphaned submodule is deleted and the caller updated. `react-doctor` must stay 100.

**Take (shared primitives + tokens):** `ui/button`, `ui/accordion`, `ui/avatar-image`, and the additive `index.css` rules (`.intake-stagger` delays, `.submit-dock-btn[data-live]`, accordion hover). No token is renamed or removed; the `:root`/`.dark` oklch palette already exists identically on both sides.

**Take + promote (theme):** the PR's dev-only dark-mode toggle becomes a **user-facing light/dark toggle**.
- The component is renamed `DevThemeToggle` → `ThemeToggle`, id `dev-dark-toggle` → `theme-toggle`.
- The persistence lib (`lib/devDarkMode.ts`) becomes `lib/theme.ts` with key **`theme`** holding `"light"`/`"dark"`. A one-time read migrates the old `dev-dark-mode` value (`"1"` → dark); when nothing is stored, initial state seeds from `prefers-color-scheme`.
- The `import.meta.env.DEV` gates in `TaskPane.tsx` and `main.tsx` are removed so the toggle ships and the persisted theme applies before paint in production.
- **The toggle renders only when logged in**, inside the existing profile header (`absolute top-1 right-5`) beside `FeishuProfile`. It is intentionally absent from the login surface, so the kept `ConnectCard`/`LoginScreen` is untouched.

**Keep `main` (do not take the PR version):**
- **The existing-sync reconcile UX.** The PR's intake set deleted the `existingSync` short-circuit (`getBitableSyncByConversation` → `ExistingSyncCheckingScreen` → "Already synced"). That guardrail is the UI expression of [ADR-0018](0018-request-sync-outbox-and-reconcile.md)'s no-duplicate intent and the no-touch HARD RULE: re-opening an already-synced conversation must show "Already synced — Open in Feishu", never a fresh intake form that could write a second Base row. `RequestIntakeScreen` is therefore **hand-adapted** (take visuals, keep gating), `useRequestSync` keeps its conversation-scoped signature returning `existingSync`, and `ReceivedScreen` is kept intact (no dead-code trim).
- `SyncScreen` (prop shape `{ requests }` only — the PR's extra `clientEmail`/`coworkerCount` args are dropped at the call sites), the login/`ConnectCard` surface, `FeishuProfile`, and the shared `initials.ts` module.

## Consequences

- `RequestIntakeScreen` is the one genuinely hand-merged file: PR layout + `main`'s `existingSync` branch. A naive whole-file take of the PR would silently drop duplicate-sync protection.
- The e2e login assertions stay on `main`'s `getByRole("region", { name: "Feishu sign in" })`; the PR's `"Connect to Feishu"` heading selector (a string present in no source file) is **not** ported.
- `CustomerPicker` adopts the PR's per-keystroke search (the 250 ms debounce and `MIN_SERVER_SEARCH_LENGTH=2` gate are removed). This raises server-search volume against the **Customer Mirror**; accepted for snappier first-character results. Revisit under [ADR-0016](0016-customer-search-modes-and-observability.md) if request volume regresses.
- The theme toggle is logged-in-only, so unauthenticated users get the default (OS-seeded) theme with no control until sign-in.
- `docs/taskpane-ui-guardrails.md` "Dev affordances" section is rewritten to "Theme toggle" (drops the "never ships in production" language); `docs/submit-dock-sync-gate.md` ships with `submitSyncGate`.
- Deploy stays in lockstep (SPA + same-commit Convex) even though no backend changed.

## Alternatives considered

- **Merge PR #25 wholesale.** Rejected: reverts the `coworker-picker/` decomposition, drops the `existingSync` guardrail, breaks the kept `SyncScreen`/`ReceivedScreen` call shapes, and ships a permanently dev-only toggle.
- **Accept removal of `existingSync` and trim `ReceivedScreen`.** Rejected: re-introduces a duplicate-Base-row path against [ADR-0018](0018-request-sync-outbox-and-reconcile.md) and contradicts the reason the Received page is kept from `main`.
- **Theme toggle visible pre-login / on all screens.** Rejected for now: would add surface to the kept login component for marginal benefit; logged-in-only keeps the kept login path untouched.
