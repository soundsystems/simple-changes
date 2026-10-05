import { describe, expect, test } from "bun:test";
import {
  auditMarkdown,
  proseLines,
  withoutHtmlComments,
} from "../../../skills/simple-changes/scripts/lib/markdown.ts";

describe("Markdown audit", () => {
  test("accepts real multiline Markdown", () => {
    const audit = auditMarkdown("## Summary\n\n- Focused outcome\n");
    expect(audit.valid).toBe(true);
    expect(audit.hasRealNewlines).toBe(true);
  });

  test("rejects escaped newline separators", () => {
    const audit = auditMarkdown("## Summary\\n- Focused outcome");
    expect(audit.valid).toBe(false);
    expect(audit.literalNewlineEscapes).toBe(1);
  });

  test("ignores an escaped newline inside code in a multiline body", () => {
    const body = [
      "## Summary",
      "",
      'Split on `"\\n"` before parsing.',
      "",
      "```ts",
      'const lines = text.split("\\n");',
      "```",
      "",
    ].join("\n");
    expect(auditMarkdown(body)).toMatchObject({
      literalNewlineEscapes: 0,
      valid: true,
    });
    expect(auditMarkdown(`${body}Then\\nmore prose.\n`)).toMatchObject({
      literalNewlineEscapes: 1,
      valid: false,
    });
  });

  test("counts every escape in a single-line body, code or not", () => {
    expect(
      auditMarkdown("```ts\\nconst a = 1;\\n```").literalNewlineEscapes
    ).toBe(2);
  });
});

describe("Markdown prose", () => {
  test("blanks fenced code and inline code while keeping line positions", () => {
    const span = "`## not a heading`";
    const notAFence = "```` not a fence `x` ````";
    const lines = proseLines(
      [
        `Before ${span} after`,
        "~~~md",
        "## Fenced",
        "~~~",
        notAFence,
        "Unclosed `tick stays",
      ].join("\n")
    );
    expect(lines).toEqual([
      `Before ${" ".repeat(span.length)} after`,
      "",
      "",
      "",
      " ".repeat(notAFence.length),
      "Unclosed `tick stays",
    ]);
  });

  test("removes HTML comments without moving later lines", () => {
    expect(withoutHtmlComments("a <!-- one\ntwo --> b\nc")).toBe(
      `a ${" ".repeat("<!-- one".length)}\n${" ".repeat("two -->".length)} b\nc`
    );
  });
});
