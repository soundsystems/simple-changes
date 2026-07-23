export interface MarkdownAudit {
  hasRealNewlines: boolean;
  issues: string[];
  literalNewlineEscapes: number;
  valid: boolean;
}

const LITERAL_NEWLINE_PATTERN = /\\n/gu;

export const auditMarkdown = (body: string): MarkdownAudit => {
  const literalNewlineEscapes =
    body.match(LITERAL_NEWLINE_PATTERN)?.length ?? 0;
  const hasRealNewlines = body.includes("\n");
  const issues: string[] = [];
  if (!body.trim()) {
    issues.push("Markdown body is empty.");
  }
  if (literalNewlineEscapes > 0) {
    issues.push(
      `Found ${literalNewlineEscapes} literal \\n sequence(s); use real line breaks.`
    );
  }
  if ((body.includes("## ") || body.includes("- ")) && !hasRealNewlines) {
    issues.push("Structured Markdown has no real newline characters.");
  }
  return {
    hasRealNewlines,
    issues,
    literalNewlineEscapes,
    valid: issues.length === 0,
  };
};
