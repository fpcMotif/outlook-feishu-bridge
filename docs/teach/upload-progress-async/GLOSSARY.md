# Upload progress async glossary

Terms for the Outlook taskpane eager-upload path: picker → module-level orchestration → `intakeReducer` → attachment row icon fill.

## Terms

**In-flight dedupe**:
A module-level `Map<fileId, Promise<void>>` so a second call for the same id returns the **same** promise instead of starting another XHR upload.
_Avoid_: “upload lock”, “debounce upload”

**TOCTOU (time-of-check/time-of-use)**:
A race where code **checks** a condition (e.g. “not in `inFlight`”), then **uses** shared state after an `await` or gap, so a concurrent caller passes the same check and starts duplicate work.
_Avoid_: “timing bug”, “async glitch”

**Monotonic progress**:
Stored and displayed upload percent **never decreases** during one in-flight upload; late events with lower values are ignored via `Math.max` (and display guards).
_Avoid_: “only go up”, “no backwards bar”

**Indeterminate vs determinate (upload fill)**:
**Indeterminate**: pulsing fill with no numeric percent (`aria-valuenow` unset) — used only while `status === "pending"` before bytes move. **Determinate**: `scaleY` driven by a 0–100 value from XHR + smoothing.
_Avoid_: “loading spinner”, “animated bar” (ambiguous)

**XHR upload progress**:
`postBytesToConvexWithProgress` reports loaded bytes; callbacks dispatch `uploadProgressUpdated` into the reducer.
_Avoid_: “fetch progress”, “axios onUploadProgress” (different stack here)

**Display smoothing**:
`useSmoothedUploadProgress` eases the icon fill toward a **target** (`uploadDisplayProgressTarget` + simulated cap while XHR is quiet) so the UI does not strobe on every XHR tick.
_Avoid_: “CSS transition on progress” (state layer is separate)

**Eager upload orchestration**:
Upload starts when files are added (`queueIntakeFileUploads`), not at sync submit — React stays thin; `uploadIntakeFile.ts` owns async + dedupe.
_Avoid_: “background upload hook”
