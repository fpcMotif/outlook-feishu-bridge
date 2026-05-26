import { useState, useCallback, useEffect } from "react";
import { dtime } from "../debug";

// ADR-0005: the email PDF is a TEXT-ONLY, selectable VECTOR document (images
// are forwarded as separate attachments, never embedded). We render it with
// jsPDF using the built-in Helvetica font — fully synchronous, no web worker,
// no async font loading. pdfmake was tried first but its `getBuffer` never
// completes inside the Outlook WebView (both the rich and plain-text paths
// timed out), so we render plain wrapped text instead. Latin only: Helvetica
// has no CJK glyphs — if CJK forwarding becomes common, embed a CJK font.
//
// jsPDF (and its transitive html2canvas/dompurify) is loaded via dynamic
// import() so it code-splits out of the initial taskpane bundle; it's preloaded
// on mount so it's warm by the time the user clicks Forward.

type JsPdfCtor = typeof import("jspdf").jsPDF;

let jsPdfPromise: Promise<JsPdfCtor> | null = null;
function loadJsPdf(): Promise<JsPdfCtor> {
  jsPdfPromise ??= import("jspdf").then((m) => m.jsPDF);
  return jsPdfPromise;
}

const PAGE = { margin: 40, headerSize: 16, bodySize: 11, headerLine: 20, bodyLine: 15, gap: 8 };

/** Pure render: subject header + wrapped body text → PDF bytes. Runs anywhere. */
export function renderTextPdf(JsPDF: JsPdfCtor, subject: string, body: string): ArrayBuffer {
  const pdf = new JsPDF({ unit: "pt", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const maxW = pageW - PAGE.margin * 2;
  let y = PAGE.margin;

  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(PAGE.headerSize);
  for (const line of pdf.splitTextToSize(subject || "(no subject)", maxW) as string[]) {
    pdf.text(line, PAGE.margin, y);
    y += PAGE.headerLine;
  }
  y += PAGE.gap;

  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(PAGE.bodySize);
  for (const line of pdf.splitTextToSize(body || "(no body text)", maxW) as string[]) {
    if (y > pageH - PAGE.margin) {
      pdf.addPage();
      y = PAGE.margin;
    }
    pdf.text(line, PAGE.margin, y);
    y += PAGE.bodyLine;
  }

  return pdf.output("arraybuffer");
}

export function useEmailPdf() {
  const [generating, setGenerating] = useState(false);

  // Warm the jsPDF chunk so the first Forward isn't slowed by the import.
  useEffect(() => {
    void loadJsPdf().catch(() => {});
  }, []);

  // `body` is the already-read mail text (from useMailItem) — reusing it avoids
  // a second Office `body.getAsync` round-trip (~0.6s) just to render the PDF.
  const generatePdf = useCallback(async (subject: string, body: string): Promise<ArrayBuffer> => {
    setGenerating(true);
    const t0 = performance.now();
    try {
      const tLib = performance.now();
      const JsPDF = await loadJsPdf();
      dtime("pdf: jsPDF ready", tLib);
      const tRender = performance.now();
      const buf = renderTextPdf(JsPDF, subject, body);
      dtime(`pdf: rendered via jsPDF → ${buf.byteLength}B`, tRender);
      dtime("pdf: DONE", t0);
      return buf;
    } finally {
      setGenerating(false);
    }
  }, []);

  return { generating, generatePdf };
}
