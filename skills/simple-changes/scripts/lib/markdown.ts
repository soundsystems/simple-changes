export interface MarkdownAudit {
  hasRealNewlines: boolean;
  issues: string[];
  literalNewlineEscapes: number;
  valid: boolean;
}

const LITERAL_NEWLINE_PATTERN = /\\n/gu;
const LINE_BREAK_PATTERN = /\r?\n/u;
const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const FENCE_CLOSE_PATTERN = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/gu;
const NOT_LINE_BREAK_PATTERN = /[^\n]/gu;

/** Blank every inline code span on one line, keeping its width. */
const blankInlineCode = (line: string): string => {
  let result = "";
  let index = 0;
  while (index < line.length) {
    if (line[index] !== "`") {
      result += line[index];
      index += 1;
      continue;
    }
    let run = 0;
    while (line[index + run] === "`") {
      run += 1;
    }
    // A span closes at the next backtick run of exactly the same length.
    let search = index + run;
    let close = -1;
    while (search < line.length) {
      const next = line.indexOf("`", search);
      if (next < 0) {
        break;
      }
      let length = 0;
      while (line[next + length] === "`") {
        length += 1;
      }
      if (length === run) {
        close = next;
        break;
      }
      search = next + length;
    }
    if (close < 0) {
      result += "`".repeat(run);
      index += run;
      continue;
    }
    result += " ".repeat(close + run - index);
    index = close + run;
  }
  return result;
};

/**
 * The body's lines with code removed: fenced code blocks (fences included)
 * become empty lines and inline code spans become spaces, so line numbers and
 * columns still match the source. Headings, links, and signatures shown inside
 * code are examples, not structure.
 */
export const proseLines = (body: string): string[] => {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of body.split(LINE_BREAK_PATTERN)) {
    if (fence !== null) {
      const closing = FENCE_CLOSE_PATTERN.exec(line)?.[1];
      if (
        closing &&
        closing[0] === fence[0] &&
        closing.length >= fence.length
      ) {
        fence = null;
      }
      lines.push("");
      continue;
    }
    const opening = FENCE_OPEN_PATTERN.exec(line);
    const marker = opening?.[1];
    // A backtick fence's info string cannot contain a backtick; such a line is
    // inline code, not a fence.
    if (marker && !(marker[0] === "`" && opening?.[2]?.includes("`"))) {
      fence = marker;
      lines.push("");
      continue;
    }
    lines.push(blankInlineCode(line));
  }
  return lines;
};

/** Remove HTML comments, which a forge never renders, keeping line count. */
export const withoutHtmlComments = (text: string): string =>
  text.replace(HTML_COMMENT_PATTERN, (comment) =>
    comment.replace(NOT_LINE_BREAK_PATTERN, " ")
  );

export const auditMarkdown = (body: string): MarkdownAudit => {
  const hasRealNewlines = body.includes("\n");
  // A body without one real line break is a single escaped string, so every
  // \n in it counts. Otherwise \n inside code is code, not a lost line break.
  const prose = hasRealNewlines ? proseLines(body).join("\n") : body;
  const literalNewlineEscapes =
    prose.match(LITERAL_NEWLINE_PATTERN)?.length ?? 0;
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
