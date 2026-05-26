import { describe, it, expect } from "vitest";
import { cleanMarkdown, parseInlineElements, markdownToBlocks } from "./markdown";

describe("cleanMarkdown", () => {
  it("strips leftover backslash escapes from the HTML->Markdown step", () => {
    expect(cleanMarkdown("price is 5\\.00 and 10\\% off")).toBe("price is 5.00 and 10% off");
  });
  it("removes html comments and image markdown (incl. cid: inline images)", () => {
    expect(cleanMarkdown("x<!-- c -->y")).toBe("xy");
    expect(cleanMarkdown("![logo](cid:abc)z")).toBe("z");
    expect(cleanMarkdown("![a](http://i/p.png)q")).toBe("q");
  });
  it("keeps real backslashes before word/space characters untouched", () => {
    expect(cleanMarkdown("a\\1")).toBe("a\\1");
  });
});

describe("parseInlineElements", () => {
  it("splits plain, bold and link runs in order", () => {
    const els = parseInlineElements("a **b** [c](http://x) d");
    expect(els).toEqual([
      { text_run: { content: "a " } },
      { text_run: { content: "b", text_element_style: { bold: true } } },
      { text_run: { content: " " } },
      { text_run: { content: "c", text_element_style: { link: { url: encodeURIComponent("http://x") } } } },
      { text_run: { content: " d" } },
    ]);
  });
  it("returns the whole line as one run when there is no inline markup", () => {
    expect(parseInlineElements("just text")).toEqual([{ text_run: { content: "just text" } }]);
  });
});

describe("markdownToBlocks", () => {
  it("skips the H1 title and blank lines", () => {
    expect(markdownToBlocks("# Title\n\n")).toEqual([]);
  });
  it("maps ## to a heading2 block (block_type 4)", () => {
    expect(markdownToBlocks("## Hello")).toEqual([
      { block_type: 4, heading2: { elements: [{ text_run: { content: "Hello" } }] } },
    ]);
  });
  it("maps a horizontal rule to a divider block (block_type 22)", () => {
    expect(markdownToBlocks("---")).toEqual([{ block_type: 22, divider: {} }]);
  });
  it("maps plain prose to a paragraph block (block_type 2)", () => {
    expect(markdownToBlocks("hi there")).toEqual([
      { block_type: 2, text: { elements: [{ text_run: { content: "hi there" } }] } },
    ]);
  });
});
