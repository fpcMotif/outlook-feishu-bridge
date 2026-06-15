---
name: design-system-review
description: Reviews Outlook Sales UI changes for design-system adoption, token consistency, duplicate component patterns, and taskpane regression risk. Use when reviewing frontend changes, adding UI, migrating components, or checking whether a page bypasses the shared Design System.
---

# Design System Review

## Quick start

1. Read `docs/design-system.md` and `docs/taskpane-ui-guardrails.md`.
2. Inspect the changed UI files and identify every new or modified visual pattern.
3. Check imports: base primitives should come from `@/design-system`; taskpane
   composites should come from `@/design-system/taskpane`.
4. Report findings before summaries, ordered by severity, with file and line
   references.

## Review checks

- Tokens: colors, focus rings, shadows, radii, typography, and animations use
  `src/index.css` tokens/utilities instead of ad-hoc semantics.
- Components: repeated taskpane shell, state, search, selection, upload, and
  dock patterns use shared components instead of bespoke copies.
- Interaction: buttons keep at least a 40px hit area, focus-visible states,
  disabled states, and scale-on-press behavior where appropriate.
- Accessibility: labels, roles, `aria-*` wiring, keyboard search behavior, and
  dialog/popover semantics remain intact.
- Business boundary: design-system components do not import Office, Feishu,
  Convex, or workflow-specific data modules.
- Regression risk: changed core pages still cover connect, request intake,
  sync progress, received/success, empty, and error states.

## Suggested verification

Run the narrowest tests that cover the changed surface, then widen:

```bash
bunx vitest run src/design-system/taskpane.test.tsx
bun run typecheck
bun run lint
bun run build
bunx react-doctor@latest --verbose --diff
```

For visual changes, also run the app and smoke the taskpane at a narrow width in
light and dark modes.

