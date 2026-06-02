# Taskpane UI guardrails

The taskpane renders inside a narrow (~320–400px) Outlook pane. These notes keep
the design system coherent as it evolves.

## Token system

All tokens live in `src/index.css` (`@theme inline` + `:root` / `.dark`). Prefer
tokens over ad-hoc values.

### Focus ring

- One opacity everywhere: `focus-visible:ring-ring/20` (the search field uses
  `focus-within:ring-ring/20`), with `focus-visible:ring-[3px]`.
- Applied across `ui/{button,input,textarea,checkbox,accordion}` and
  `taskpane/{CoworkerPicker,FeishuProfile,TaskpaneSearchField}`.
- When adding a focusable control, reuse `ring-ring/20` — do not introduce a new
  opacity.

### Color semantics

- `primary` — main brand/action color (Sync button, active states).
- `accent` — a quiet **tertiary** tint (selected cards, "Live"/info chips).
- `sage` / `sage-soft` — **success** only (synced Base rows, "Connected" status).
  Do not use `accent` to signal success; do not use `sage` for tertiary chrome.
- `destructive` — errors / sign-out.

### Radius

- Use the radius scale: `rounded-{sm,md,lg,xl,2xl}` (derived from `--radius`).
- Bespoke radii (`rounded-[14px]`, `rounded-[20px]`, `rounded-[28px]`) predate the
  scale; leave them unless a value-identical token exists. There is no `--text-*`
  px scale yet, so keep `text-[Npx]` literals until one is added.

### Shadow utilities (Tailwind v4 collision-safe)

- `--shadow-border` / `--shadow-floating` are the source tokens.
- Apply them via `.shadow-edge` (border/elevation) and `.shadow-float`
  (floating/popover), defined under `@layer utilities` in `index.css`. They alias
  the tokens so rendered output is identical to the old inline values.
- Named distinctly on purpose: in Tailwind v4 a bare `shadow-border` would map to
  the `--color-border` token. Never reintroduce inline `shadow-[var(--shadow-*)]`.
- Genuine one-offs (selection ring `shadow-[0_0_0_1.5px_...]`, the dock's top
  fade, the received-screen step ring) stay inline.

## Accessibility

- Search dropdowns (`TaskpaneSearchDropdown` + `TaskpaneSearchField`) are ARIA
  comboboxes: the input carries `role="combobox"`, `aria-expanded`,
  `aria-controls`, `aria-activedescendant`, `aria-autocomplete="list"`; the panel
  is `role="listbox"`.
- Option buttons stay native `<button>`s (so they remain discoverable as buttons)
  and are tagged `data-search-option` + `aria-selected`; the dropdown rovers the
  active option over them. Do **not** override their role with `role="option"` —
  existing tests find coworker/customer rows by the button role.
- Keyboard: ArrowDown/ArrowUp move the active option (wrap-around), Enter selects,
  Escape closes. Mouse behavior is unchanged. The key→action logic is a pure,
  unit-tested helper (`taskpaneSearchKeyboard.ts`); `scrollIntoView` is guarded
  with `?.` because jsdom does not implement it.

## Theme toggle

- A user-facing light/dark switch (`ThemeToggle`, id `theme-toggle`) lives in the
  logged-in profile header next to the account menu. `initThemeFromStorage()` in
  `main.tsx` applies the persisted theme to `<html>` (`.dark` class) before React
  paints; `src/lib/theme.ts` is the single source of truth for read/apply/persist
  (storage key `theme` = `light`/`dark`, migrating the legacy `dev-dark-mode` key
  and seeding from `prefers-color-scheme`). One toggle only — do not reintroduce a
  second injector (`document.createElement`, a fixed FAB in `App`, or a dev-gated
  duplicate). See [ADR-0020](adr/0020-selective-merge-pr25-build-intake-and-user-theme.md).

## Submit dock sync gate

The bottom Sync button requires customer, coworker, and at least one request
note with non-empty text. See [submit-dock-sync-gate.md](./submit-dock-sync-gate.md).

## Section structure (prior incident)

Same visual role = same component and same DOM structure. First-level
request-builder sections go through `TaskpaneSection` + `SectionLabel` so the
wrapper, header, label, spacing, and rule width live in one place. Do not copy
`SectionLabel` classes into a different wrapper; change `TaskpaneSection` /
`SectionLabel` and check every first-level peer (`New request` in
`RequestIntakeScreen.tsx`, `Customer & coworker` in `CoworkerPicker.tsx`). The
hero is intentionally not a `TaskpaneSection`. Inner labels (e.g. the
`Feishu coworker` search label) stay local to their control.

## Ongoing UI loop

1. `bun run dev` (or `bun run dev:https` for sideloaded Outlook).
2. Screenshot the key states at ~360px: connect, request intake,
   coworker/customer pickers (empty + results + selected), sync progress,
   received/success, and the profile popover. Toggle the light/dark theme switch
   and recapture.
3. Critique with the frontend-design skill against this token system (focus ring,
   color semantics, radius, shadow utilities).
4. Adjust **tokens/components**, not one-off inline values.
5. Re-screenshot and compare.
6. `/code-review`, then the gate: `bun run typecheck` → `bun run lint` →
   `bun run test` (all green).
7. Commit.

For pixel-sensitive changes, unit tests that only assert text exists are not
enough — capture screenshots (`E2E_SCREENSHOT_DIR`) and compare computed styles /
bounding boxes for `#new-request-title` and `#client-coworker-title`.

## Open questions

- No `--text-*` px scale yet; `text-[Npx]` literals remain until one is introduced.
- No automated visual regression tests; rely on the screenshot loop above.
