# The forwarded-email PDF is text-only vector, rendered client-side; images ride as attachments

> **Status: superseded by [ADR-0010](0010-pivot-to-bitable-intake.md).** Historical — the email PDF is retired in the Bitable-intake pivot; kept for context.

Forwarding an email attaches a PDF of its content to the Feishu message. We render that PDF **client-side in the taskpane** as **text-only vector** with **jsPDF**: the email body via Office `Text` coercion, laid out as wrapped, selectable text under a bold subject header. Images are **deliberately excluded** from the PDF — they are forwarded separately as Feishu attachments / inline media, so the PDF stays small and no image is sent twice.

This replaces the previous approach — `html2canvas` rasterizing the email DOM into a PNG bitmap embedded via `jsPDF.addImage` — which produced ~3 MB screenshots for a ~100-word email, was slow, and had no selectable text. `html2canvas` is removed; jsPDF is retained but now writes **selectable text** (`.text()` / `.splitTextToSize()`) rather than embedding a canvas image.

## Why not headless Chromium (the "mature" path)

Headless-Chromium `page.pdf()` is the industry-standard high-fidelity HTML→PDF engine, but it cannot run inside a Convex Node action and would require either a Chromium service (e.g. on the ECS Host) or a third-party SaaS — extra ops, and for SaaS an extra cross-border hop on the China path plus the email content leaving to a vendor. We chose to **stay client-side** (no new infra) and accept a text PDF, which is fine here because images are handled as attachments and pixel-fidelity is not a goal.

## Considered and rejected

- **Optimized raster** (html2canvas → JPEG + compress): smaller/faster than today but still a screenshot with no selectable text — and pointless once images are excluded.
- **Vector/raster hybrid**: the raster branch only existed to faithfully render images/complex layout; excluding images removed its reason to exist.

## Consequences

- **Tiny, selectable PDFs** (tens of KB vs ~3 MB), generated faster, and the heavy `html2canvas` dependency is dropped.
- **No images or pixel-faithful layout in the PDF — by design.** A reader expecting a visual replica will be surprised; that's why this is recorded.
- **Rich formatting is dropped** — the PDF is plain wrapped text (no bold/links/lists from the body), since we render the Office `Text` coercion, not the HTML. For a forwarding/archival PDF this is an acceptable trade for reliability + size; the email itself is untouched.
- **`cid:` inline images** don't render in the PDF (nor did they in the old iframe raster); they must be forwarded as attachments to reach the recipient.

## Implementation & verification

- **Library:** `jspdf` only — built-in Helvetica, **synchronous**, no web worker and no async font loading. `renderTextPdf(subject, body)` writes the bold subject then the wrapped body (`splitTextToSize`), paginating as needed, and returns `output("arraybuffer")`.
- **Why not pdfmake:** the first cut used `html-to-pdfmake` + `pdfmake` (rich text — bold/links/lists). It builds, types, and unit-tests fine, but `pdfmake.getBuffer` **never completes inside the Outlook WebView** — both the rich and the trivial plain-text paths hit the guard (`"PDF generation timed out"`). pdfmake 0.3.x uses **no web worker**, so it is *not* a CSP block; the renderer simply hangs in that sandbox. An earlier `SegoeUiLight` crash (html-to-pdfmake emits a pdfmake `font` per CSS `font-family`, and only Roboto is registered) was fixed by stripping `font` props, but the hang is separate and fatal — so we dropped pdfmake. jsPDF already worked here for the old raster path.
- **Transport:** because the text PDF is tiny (~5 KB) it rides **inline** as a `pdfBytes` arg straight to the `forwardToFeishu` action, which uploads it to Feishu server-side — collapsing the whole forward to one CN→US round-trip. Staging it in File Storage first measured **~3 s** of needless latency, so that path is reserved for a large PDF (> 4 MiB). See [ADR-0004](0004-binaries-cross-via-convex-file-storage.md). (The raster PDF *was* what blew the 5 MiB arg cap; text output removed that risk.)
- **Resilience:** PDF generation is **best-effort** in the orchestration — a failure is logged (and surfaced via progress) and the forward continues (card + attachments + Doc still go), so one bad PDF can't strand the whole forward.
- **Scope — Latin only:** Helvetica has **no CJK glyphs**, so Chinese/Japanese/Korean body text would render as blank boxes. Deliberate (forwarded mail here is mostly English/Latin); embed a CJK font if that changes.
- **Verified:** `tsc` + `vite build` clean; a unit test renders a real PDF **in jsdom** and asserts it starts with `%PDF-`, paginates a long body, and stays < 100 KB (jsPDF runs under node/jsdom, unlike pdfmake's browser-only `getBuffer`).
