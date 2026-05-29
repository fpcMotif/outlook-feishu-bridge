# Taskpane UI Guardrails

Scope: this note only covers the recent request-builder visual drift around the
`New request` and `Customer & coworker` section labels.

## Incident

The two labels looked equivalent in component code but did not render equivalent
in the taskpane. The root cause was not the label styling alone: the same label
component was sitting inside different parent spacing and wrapper structures.
Small padding and margin fixes treated symptoms and created a whack-a-mole loop.

## Rule

Same visual role = same component and same DOM structure.

Do not copy `SectionLabel` classes into a different wrapper when a section is
supposed to align with another first-level taskpane section. Put both sections
through `TaskpaneSection` so the wrapper, header, label, spacing, and line width
can only change in one place.

## Current Invariant

First-level request-builder sections use:

- `TaskpaneSection` for the outer section shell.
- `SectionLabel` for the uppercase label row.
- The same `section -> header -> label -> content` DOM shape.
- Shared tokens in those components, including `space-y-3`, `h-4`,
  `leading-none`, and the same label rule width.

The current first-level peers are:

- `New request` in `RequestIntakeScreen.tsx`.
- `Customer & coworker` in `CoworkerPicker.tsx`.

The hero is intentionally not a `TaskpaneSection`; do not compare hero spacing to
section-label spacing.

## How To Change This Safely

- If a new first-level taskpane section should visually align with these labels,
  route it through `TaskpaneSection`.
- If the label height, leading, rule width, or top-level spacing needs to change,
  change `SectionLabel` or `TaskpaneSection`, then check every first-level peer.
- If only one section looks off, first inspect its parent DOM and spacing context.
  Avoid local padding or margin patches unless the section truly has a different
  visual role.
- Inner labels such as the `Feishu coworker` search label can stay local to their
  control. They are not first-level section labels.

## Regression Checks

Unit tests that assert text exists are not enough for this class of bug. They can
prove both labels render while still missing a four-pixel layout drift.

For pixel-sensitive taskpane changes:

- Run the browser/e2e path and capture screenshots with `E2E_SCREENSHOT_DIR`.
- Compare computed styles and bounding boxes for `#new-request-title` and
  `#client-coworker-title`, not only screenshots.
- Check the rendered bundle after a hard refresh or taskpane reopen before
  trusting the screenshot. Frontend and backend deploys can change separately.

The useful question is: "Could these two labels diverge if someone changes only
one parent?" If yes, the structure is still too easy to break.
