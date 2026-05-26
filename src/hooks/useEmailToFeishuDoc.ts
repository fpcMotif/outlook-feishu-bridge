import { useState, useCallback } from "react";
import TurndownService from "turndown";
import { readMailBodyHtml } from "../office/mailBody";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

function convertHtmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}

function buildMarkdownWithHeader(
  bodyMarkdown: string,
  subject: string,
  from: string,
  to: string[],
  cc: string[],
  date?: Date,
): string {
  const lines = [
    `# ${subject}`,
    "",
    `**From:** ${from}`,
    ...(to.length > 0 ? [`**To:** ${to.join(", ")}`] : []),
    ...(cc.length > 0 ? [`**CC:** ${cc.join(", ")}`] : []),
    ...(date ? [`**Date:** ${date.toLocaleString()}`] : []),
    "",
    "---",
    "",
    bodyMarkdown,
  ];
  return lines.join("\n");
}

export function useEmailToFeishuDoc() {
  const [generating, setGenerating] = useState(false);

  const generateMarkdown = useCallback(
    async (
      subject: string,
      from: string,
      to: string[],
      cc: string[],
      date?: Date,
    ): Promise<string> => {
      setGenerating(true);
      try {
        const htmlBody = await readMailBodyHtml();
        const bodyMarkdown = convertHtmlToMarkdown(htmlBody);
        return buildMarkdownWithHeader(bodyMarkdown, subject, from, to, cc, date);
      } finally {
        setGenerating(false);
      }
    },
    [],
  );

  return { generating, generateMarkdown };
}
