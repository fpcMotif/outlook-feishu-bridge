// Pure markdown -> Feishu Doc block translation. No I/O and no convex deps, so
// the bug-prone parsing (inline bold/links, headings, dividers, escape cleanup)
// sits behind one interface and is unit-testable on its own. Block type numbers
// follow the Feishu docx API: paragraph = 2, heading1..9 = 3..11, divider = 22.

export interface TextElementStyle {
  bold?: true;
  link?: { url: string };
}

export interface TextElement {
  text_run: { content: string; text_element_style?: TextElementStyle };
}

export interface FeishuBlock {
  block_type: number;
  text?: { elements: TextElement[] };
  heading1?: { elements: TextElement[] };
  heading2?: { elements: TextElement[] };
  heading3?: { elements: TextElement[] };
  heading4?: { elements: TextElement[] };
  heading5?: { elements: TextElement[] };
  heading6?: { elements: TextElement[] };
  heading7?: { elements: TextElement[] };
  heading8?: { elements: TextElement[] };
  heading9?: { elements: TextElement[] };
  divider?: Record<string, never>;
}

export function cleanMarkdown(markdown: string): string {
  return markdown
    .replaceAll(/<!--[\s\S]*?-->/g, "")
    .replaceAll(/!\[[^\]]*\]\(cid:[^)]*\)/g, "")
    .replaceAll(/!\[[^\]]*\]\([^)]*\)/g, "")
    // Strip leftover backslash escapes from the HTML->Markdown step (turndown),
    // which otherwise surface literally in the non-markdown Feishu doc.
    .replaceAll(/\\([^\w\s])/g, "$1");
}

export function parseInlineElements(line: string): TextElement[] {
  const elements: TextElement[] = [];
  const regex = /\*\*(.*?)\*\*|\[([^\]]*)\]\(([^)]*)\)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      elements.push({ text_run: { content: line.slice(lastIndex, match.index) } });
    }
    if (match[1] !== undefined) {
      elements.push({ text_run: { content: match[1], text_element_style: { bold: true } } });
    } else if (match[2] !== undefined && match[3] !== undefined) {
      elements.push({
        text_run: { content: match[2], text_element_style: { link: { url: encodeURIComponent(match[3]) } } },
      });
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < line.length) {
    elements.push({ text_run: { content: line.slice(lastIndex) } });
  }
  if (elements.length === 0) {
    elements.push({ text_run: { content: line } });
  }
  return elements;
}

const HEADING_KEYS = [
  "heading1", "heading2", "heading3", "heading4", "heading5",
  "heading6", "heading7", "heading8", "heading9",
] as const;

function makeHeadingBlock(level: number, text: string): FeishuBlock {
  const key = HEADING_KEYS[level - 1];
  return { block_type: level + 2, [key]: { elements: parseInlineElements(text) } } as FeishuBlock;
}

export function markdownToBlocks(markdown: string): FeishuBlock[] {
  const cleaned = cleanMarkdown(markdown);
  const lines = cleaned.split("\n");
  const blocks: FeishuBlock[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const headingMatch = trimmed.match(/^(#{1,9})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      // H1 is the doc title already; skip to avoid a duplicate top heading.
      if (level === 1) continue;
      blocks.push(makeHeadingBlock(level, headingMatch[2]));
      continue;
    }
    if (/^[-*_]{3,}$/.test(trimmed)) {
      blocks.push({ block_type: 22, divider: {} });
      continue;
    }
    blocks.push({ block_type: 2, text: { elements: parseInlineElements(trimmed) } });
  }
  return blocks;
}
