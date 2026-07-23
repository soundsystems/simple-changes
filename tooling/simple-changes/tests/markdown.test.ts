import { describe, expect, test } from "bun:test";
import { auditMarkdown } from "../../../skills/simple-changes/scripts/lib/markdown.ts";

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
});
