# Upload progress async — teaching workspace

Study pack for the attachment icon fill restart bug (async dedupe + monotonic progress).

| File | Purpose |
|------|---------|
| [MISSION.md](./MISSION.md) | Why you're learning this |
| [GLOSSARY.md](./GLOSSARY.md) | Canonical terms |
| [learning-records/0001-upload-fill-restart-race.md](./learning-records/0001-upload-fill-restart-race.md) | Non-obvious lesson (LR-0001) |
| [explainers/0001-bad-vs-good-upload-async.html](./explainers/0001-bad-vs-good-upload-async.html) | Bad vs good snippets + sequence diagram |

## Open the explainer (Windows)

```powershell
start docs\teach\upload-progress-async\explainers\0001-bad-vs-good-upload-async.html
```

Or open that path in your browser from the repo root: `c:\Users\fenchem\outlook-sales\docs\teach\upload-progress-async\explainers\0001-bad-vs-good-upload-async.html`

Source modules: `src/components/taskpane/uploadIntakeFile.ts`, `intakeReducer.ts`, `AttachmentSectionRows.tsx`, `AttachmentSectionPrimitives.tsx`, `uploadDisplayProgress.ts`.
