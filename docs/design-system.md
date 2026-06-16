# Design System

This project's UI runs inside a narrow Outlook taskpane, so the design system
optimizes for dense, reliable business workflows over decorative page layouts.
New UI should use the component-library entry in `src/design-system` before
reaching into lower-level implementation files.

## Inventory

Current surface, taken from the June 12, 2026 migration pass:

| Tier | Files / source | Role |
| --- | --- | --- |
| Tokens | `src/index.css` | OKLCH color tokens, dark-mode tokens, radius scale, focus rings, shadows, taskpane animations, scrollbar and submit-dock utilities. |
| Base primitives | `src/components/ui/*`, re-exported by `src/design-system/index.ts` | Button, badge, card, avatar, checkbox, input, textarea, accordion, and `cn`. |
| Taskpane composites | `src/design-system/taskpane.tsx` plus existing taskpane composites | App frame, main region, scroll shell, eyebrow, centered state message, inline action button, section label structure, selection row, search field/dropdown, submit dock, attachment rows. |
| Business components | `src/components/taskpane/*Screen.tsx`, pickers, Feishu profile, attachment sync components | Screens and workflows that own domain data, Office/Feishu/Convex state, and business copy. |
| Guardrails | `docs/taskpane-ui-guardrails.md` | Focus, color semantics, radius, shadow, a11y, theme toggle, submit-gate, and screenshot loop. |

Duplicate patterns identified in the migration:

| Pattern | Previous locations | Standard component |
| --- | --- | --- |
| Taskpane scroll shell with semantic background/text and hidden scrollbar | `LoginScreen`, `ReceivedScreen` | `TaskpaneScrollShell` |
| Centered empty/error state with heading, description, and actions | `TaskPane.EmptyState`, `SyncErrorScreen` | `TaskpaneStateMessage` |
| Eyebrow label with short horizontal rule | `LoginScreen` | `TaskpaneEyebrow` |
| Link-like secondary button action | `ConnectCard.BackupLoginButton` | `InlineActionButton` |
| Base UI primitive imports | Mixed `@/components/ui/*`, `../ui/*`, `./ui/*` | `@/design-system` |

## Component Library Contract

- Import base primitives from `@/design-system`.
- Import taskpane composites from `@/design-system/taskpane`.
- Keep business state, API calls, and Feishu/Convex payload shaping out of the
  design-system directory.
- If a visual or interaction pattern appears in two business components, extract
  it into `src/design-system` or an existing shared taskpane composite before
  adding a third copy.
- Use tokens from `src/index.css`; do not add ad-hoc color, focus, shadow, or
  radius semantics unless the token layer is intentionally extended.
- Do not add dependencies for design-system work unless the user explicitly asks.

## Migration Rules

1. Preserve roles, labels, and existing tested text before changing structure.
2. Prefer deleting bespoke class stacks by moving them into named design-system
   components.
3. Keep visual changes small in migration commits; this pass is abstraction, not
   a redesign.
4. For taskpane pages, verify connect, intake, sync progress, received/success,
   and error/empty states in the browser at narrow width.
5. For React changes, run focused Vitest first, then `bun run typecheck`,
   `bun run lint`, `bun run build`, and React Doctor diff.

