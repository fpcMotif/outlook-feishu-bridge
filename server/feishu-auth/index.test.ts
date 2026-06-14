import { describe, expect, it } from "vitest";

process.env.FEISHU_APP_ID = "test";
process.env.FEISHU_APP_SECRET = "test";
process.env.FEISHU_FALLBACK_REDIRECT_URI = "test";

import { escapeHtml } from "./index";

describe("escapeHtml", () => {
  it("replaces &, <, >, \", and ' with their HTML entities", () => {
    expect(escapeHtml(`<a href='x' title="test">Tom & Jerry</a>`)).toBe(
      "&lt;a href=&#39;x&#39; title=&quot;test&quot;&gt;Tom &amp; Jerry&lt;/a&gt;"
    );
  });

  it("escapes single quotes correctly", () => {
    expect(escapeHtml("'single'")).toBe("&#39;single&#39;");
  });

  it("escapes ampersands first", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
});
