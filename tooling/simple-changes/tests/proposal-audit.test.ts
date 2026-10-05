import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "bun";
import { auditProposalBody } from "../../../skills/simple-changes/scripts/lib/proposal-audit.ts";
import { validateSchema } from "../../../skills/simple-changes/scripts/lib/schema.ts";

const fixtures = resolve(import.meta.dir, "fixtures/proposal-audit");
const fixture = (name: string): string =>
  readFileSync(join(fixtures, name), "utf8");
const cliPath = resolve(
  import.meta.dir,
  "../../../skills/simple-changes/scripts/simple-changes.ts"
);
const decoder = new TextDecoder();
// The CLI test spawns the runtime several times; spawning is slow under load.
setDefaultTimeout(30_000);

const runCli = (...args: string[]) => {
  const result = spawnSync([process.execPath, cliPath, ...args], {
    cwd: fixtures,
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: decoder.decode(result.stderr),
    stdout: decoder.decode(result.stdout),
  };
};

const MERGE_DANGER_SECTION_PATTERN = /## Merge danger\n\n[^\n]*\n[^\n]*\n\n/u;
const SIGNED = "---\n[[Authored by Fable 5.1]]\n";
const DOOR_LINE = /^\*\*Door:\*\*.*$/mu;
const DOOR_LINE_WITH_BREAK = /^\*\*Door:\*\*.*\n/mu;
const shapedWithout = (signature: string): string =>
  fixture("shaped.md").replace(
    "---\n[[Authored by Fable 5.1]]\n[[Reviewed by Opus 5]]\n",
    signature
  );

describe("proposal audit", () => {
  test("accepts the body shape with a door, a blast radius, and a final signature block", () => {
    const audit = auditProposalBody({ body: fixture("shaped.md") });
    expect(audit).toMatchObject({
      door: "two-way",
      issues: [],
      missingSections: [],
      requiredSections: ["## Summary", "## Evidence", "## Merge danger"],
      sectionSource: "default",
      signatureBlock: "last",
      valid: true,
    });
    // The fenced example's "\n" is code, not a lost line break.
    expect(audit.markdown.literalNewlineEscapes).toBe(0);
    expect(auditProposalBody({ body: shapedWithout("") })).toMatchObject({
      signatureBlock: "absent",
      valid: true,
    });
  });

  test("fails escaped line breaks before anything renders", () => {
    const audit = auditProposalBody({ body: fixture("escaped.md") });
    expect(audit.valid).toBe(false);
    expect(audit.markdown.literalNewlineEscapes).toBeGreaterThan(0);
    expect(audit.issues[0]).toContain("literal \\n");
    expect(audit.missingSections).toEqual([
      "## Summary",
      "## Evidence",
      "## Merge danger",
    ]);
  });

  test("names a missing section, an invalid door, an empty blast radius, and a signature that is not last", () => {
    const audit = auditProposalBody({ body: fixture("unshaped.md") });
    expect(audit.valid).toBe(false);
    expect(audit.door).toBeNull();
    expect(audit.missingSections).toEqual(["## Evidence"]);
    expect(audit.signatureBlock).toBe("not-last");
    expect(audit.issues).toEqual([
      'Missing the "## Evidence" section.',
      'The **Door:** line must start with one-way, two-way, or unknown, not "probably fine".',
      "The Merge danger section needs a **Blast radius:** line naming what could break.",
      "The signature block must be the last element of the body; move every signature line below the rest of the description.",
    ]);
  });

  test("requires the Door line, a non-empty section, and the rule above the signatures", () => {
    const noDoor = auditProposalBody({
      body: fixture("shaped.md").replace(DOOR_LINE_WITH_BREAK, ""),
    });
    expect(noDoor.issues).toEqual([
      "The Merge danger section needs a **Door:** line naming one-way, two-way, or unknown.",
    ]);
    const emptyEvidence = auditProposalBody({
      body: "## Summary\n\nOne retry.\n\n## Evidence\n\n## Merge danger\n\n**Door:** two-way\n**Blast radius:** webhooks\n",
    });
    expect(emptyEvidence.issues).toEqual([
      'The "## Evidence" section is empty.',
    ]);
    expect(
      auditProposalBody({ body: shapedWithout("[[Authored by Fable 5.1]]\n") })
        .issues
    ).toEqual([
      "Put a horizontal rule (---) on its own line directly above the signature lines.",
    ]);
    const underText = shapedWithout(SIGNED).replace(
      "attempts.\n\n---",
      "attempts.\n---"
    );
    expect(auditProposalBody({ body: underText }).issues).toEqual([
      "Leave a blank line above the --- before the signature block; without it the line above renders as a heading.",
    ]);
    // A signature shown inside a fenced example is not the block.
    const quoted = shapedWithout(
      `${SIGNED}\nExample:\n\n\`\`\`md\n[[Merged by Opus 5]]\n\`\`\`\n`
    );
    expect(auditProposalBody({ body: quoted }).signatureBlock).toBe("not-last");
  });

  test("uses a repository template's headings instead of the default sections", () => {
    const template = fixture("template.md");
    const templated = auditProposalBody({
      body: fixture("templated.md"),
      template,
    });
    expect(templated).toMatchObject({
      door: "unknown",
      issues: [],
      requiredSections: [
        "## What does this MR do and why?",
        "## How to test",
        "## Merge danger",
      ],
      sectionSource: "template",
      signatureBlock: "last",
      valid: true,
    });
    expect(
      auditProposalBody({ body: fixture("templated.md") }).missingSections
    ).toEqual(["## Summary", "## Evidence"]);
    const missingHeading = auditProposalBody({
      body: fixture("templated.md").replace(
        "## How to test\n",
        "How to test:\n"
      ),
      template,
    });
    expect(missingHeading.missingSections).toEqual(["## How to test"]);
    // Merge danger content is still checked when the template carries it.
    const vague = auditProposalBody({
      body: fixture("templated.md").replace(DOOR_LINE, "**Door:**"),
      template,
    });
    expect(vague.issues).toEqual([
      "The **Door:** line is empty; start it with one-way, two-way, or unknown.",
    ]);
    // A template without Merge danger still requires it beneath the template.
    const noDangerTemplate = template.replace("## Merge danger\n", "");
    expect(
      auditProposalBody({
        body: fixture("templated.md"),
        template: noDangerTemplate,
      })
    ).toMatchObject({
      issues: [],
      requiredSections: [
        "## What does this MR do and why?",
        "## How to test",
        "## Merge danger",
      ],
      valid: true,
    });
    const dangerless = auditProposalBody({
      body: fixture("templated.md").replace(MERGE_DANGER_SECTION_PATTERN, ""),
      template: noDangerTemplate,
    });
    expect(dangerless.missingSections).toEqual(["## Merge danger"]);
    expect(dangerless.valid).toBe(false);
    // A template without headings keeps the default sections.
    expect(
      auditProposalBody({
        body: fixture("shaped.md"),
        template: "Describe the change.\n",
      }).sectionSource
    ).toBe("default");
  });

  test("the CLI prints a closed report and exits by the result", () => {
    const passed = runCli("proposal", "audit", "--file", "shaped.md", "--json");
    expect(passed.stderr).toBe("");
    expect(passed.exitCode).toBe(0);
    const report = JSON.parse(passed.stdout);
    expect(validateSchema("proposal-audit", report)).toMatchObject({
      file: "shaped.md",
      template: null,
      valid: true,
    });
    expect(Object.keys(report).sort()).toEqual([
      "door",
      "file",
      "issues",
      "markdown",
      "missingSections",
      "requiredSections",
      "schemaVersion",
      "sectionSource",
      "signatureBlock",
      "template",
      "valid",
    ]);

    const failed = runCli("proposal", "audit", "--file", "unshaped.md");
    expect(failed.exitCode).toBe(3);
    expect(failed.stdout).toContain(
      "unshaped.md does not match the proposal body shape:"
    );
    expect(failed.stdout).toContain('- Missing the "## Evidence" section.');

    const templated = runCli(
      "proposal",
      "audit",
      "--file",
      "templated.md",
      "--template",
      "template.md",
      "--json"
    );
    expect(templated.exitCode).toBe(0);
    expect(JSON.parse(templated.stdout)).toMatchObject({
      sectionSource: "template",
      template: "template.md",
    });

    expect(runCli("proposal", "audit").exitCode).toBe(2);
    expect(runCli("proposal", "review", "--file", "shaped.md").exitCode).toBe(
      2
    );
    expect(runCli("proposal", "audit", "--file", "absent.md").exitCode).toBe(3);
  });
});
