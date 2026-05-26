import { describe, it, expect } from "vitest";
import { jsPDF } from "jspdf";
import { renderTextPdf } from "./useEmailPdf";

function pdfHeader(buf: ArrayBuffer): string {
  return String.fromCodePoint(...new Uint8Array(buf).slice(0, 5));
}

describe("renderTextPdf", () => {
  it("produces a valid, small PDF from subject + body", () => {
    const buf = renderTextPdf(jsPDF, "Quarterly update", "Hello team,\nHere is the update.\n".repeat(40));
    expect(pdfHeader(buf)).toBe("%PDF-");
    expect(buf.byteLength).toBeGreaterThan(0);
    // ADR-0005 target: a normal email PDF stays well under 100 KB.
    expect(buf.byteLength).toBeLessThan(100 * 1024);
  });

  it("paginates long bodies without throwing", () => {
    const buf = renderTextPdf(jsPDF, "Long mail", "Line of body text that wraps.\n".repeat(400));
    expect(pdfHeader(buf)).toBe("%PDF-");
    expect(buf.byteLength).toBeGreaterThan(0);
  });

  it("handles empty subject and body", () => {
    const buf = renderTextPdf(jsPDF, "", "");
    expect(pdfHeader(buf)).toBe("%PDF-");
    expect(buf.byteLength).toBeGreaterThan(0);
  });
});
