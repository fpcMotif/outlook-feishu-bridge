# Mission: Upload progress async races (Outlook taskpane)

## Why

The attachment upload icon fill visibly **jumped backward** (often around **30%**) while a file was still uploading. That erodes trust in the intake UI and makes it hard to tell whether Convex staging succeeded. You want to recognize **async routing mistakes** (duplicate starts, late dedupe registration, non-monotonic state) before they ship again in React + Convex taskpane code.

## Success looks like

- Spot a **TOCTOU gap** between “check `inFlight`” and “register promise” in upload orchestration.
- Explain why **`void` on an `async` starter** plus a **sync `Map.set`** beats “`async function` that sets the map after the first `await`”.
- Trace progress from **XHR callback → reducer → row props → smoothed display** without blaming “CSS” when state regressed.
- Choose **pending-only indeterminate** vs **uploading determinate** fill correctly.

## Constraints

- Ground examples in this repo’s fixed modules (`uploadIntakeFile.ts`, `intakeReducer.ts`, `AttachmentSectionRows.tsx`, `AttachmentSectionPrimitives.tsx`, `uploadDisplayProgress.ts`).
- Keep study snippets minimal (vital lines only); use the HTML explainer for side-by-side bad vs good.

## Out of scope

- Convex storage API design (ADR-0022 product rules).
- Full attachment sync / Feishu token staging at submit time.
- General React performance tuning unrelated to upload progress monotonicity.
