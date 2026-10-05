import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "bun";
import {
  checkSkill,
  type SkillCheckCode,
} from "../../../skills/simple-changes/scripts/lib/skill-check.ts";
import { writeFixture } from "./helpers.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const cliPath = resolve(
  repositoryRoot,
  "skills/simple-changes/scripts/simple-changes.ts"
);
const decoder = new TextDecoder();
// The CLI test spawns the runtime several times; spawning is slow under load.
setDefaultTimeout(30_000);
const SKILL_MARKDOWN = [
  "---",
  "name: demo-skill",
  "description: Use when testing the skill check.",
  "---",
  "",
  "# Demo",
  "",
  "Read [the guide](references/guide.md) and [its steps](references/guide.md#steps),",
  "not [the web](https://example.invalid/), [mail](mailto:demo@example.invalid),",
  "or [this page](#demo).",
  "",
  "`[inline code](missing.md)` is an example.",
  "",
  "```md",
  "[fenced](missing-too.md)",
  "```",
  "",
].join("\n");

let scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch) {
    rmSync(directory, { force: true, recursive: true });
  }
  scratch = [];
});

const createSkill = (name = "demo-skill"): string => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "skill-check-")));
  scratch.push(base);
  const root = join(base, name);
  mkdirSync(root);
  writeFixture(root, "SKILL.md", SKILL_MARKDOWN.replace("demo-skill", name));
  writeFixture(
    root,
    "references/guide.md",
    "# Guide\n\nBack to [the skill](../SKILL.md); see [one](providers/one.md).\n\n[provider]: providers/one.md\n"
  );
  writeFixture(root, "references/providers/one.md", "# One\n");
  return root;
};

const editSkill = (root: string, edit: (source: string) => string): void => {
  const path = join(root, "SKILL.md");
  writeFileSync(path, edit(readFileSync(path, "utf8")));
};

const codes = (root: string): SkillCheckCode[] =>
  checkSkill(root).issues.map((issue) => issue.code);

const runCli = (...args: string[]) => {
  const result = spawnSync([process.execPath, cliPath, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
  };
};

describe("skill check", () => {
  test("passes a well-formed skill and checks only relative links outside code", () => {
    const root = createSkill();
    expect(checkSkill(root)).toEqual({
      issues: [],
      linksChecked: 5,
      name: "demo-skill",
      schemaVersion: 1,
      skillDirectory: root,
      valid: true,
    });
  });

  test("every packaged skill passes", () => {
    for (const name of [
      "simple-changes",
      "update-local-forks",
      "publish-skill",
    ]) {
      const report = checkSkill(resolve(repositoryRoot, "skills", name), {
        selfContained: true,
      });
      expect({ issues: report.issues, name }).toEqual({ issues: [], name });
    }
  });

  test("reports a directory without SKILL.md", () => {
    const root = createSkill();
    rmSync(join(root, "SKILL.md"));
    expect(checkSkill(root)).toMatchObject({
      issues: [{ code: "skill-file-missing", path: "SKILL.md" }],
      name: null,
      valid: false,
    });
  });

  test("requires a frontmatter block that parses as strict YAML", () => {
    const missing = createSkill();
    editSkill(missing, (source) => source.slice(source.indexOf("# Demo")));
    expect(codes(missing)).toEqual(["frontmatter-missing"]);

    const unquoted = createSkill();
    editSkill(unquoted, (source) =>
      source.replace(
        "description: Use when testing the skill check.",
        "description: Use instead of simple-changes in demo: test the check."
      )
    );
    const [issue] = checkSkill(unquoted).issues;
    expect(issue?.code).toBe("frontmatter-yaml");
    expect(issue?.message).toContain('quote any value that contains ": "');

    // An empty block parses to null and is checked as missing fields.
    const empty = createSkill();
    editSkill(empty, (source) =>
      source.replace(
        "name: demo-skill\ndescription: Use when testing the skill check.\n",
        "\n"
      )
    );
    expect(codes(empty)).toEqual(["name-invalid", "description-invalid"]);
  });

  test("requires a spec name that matches its directory", () => {
    const invalid = createSkill();
    editSkill(invalid, (source) =>
      source.replace("name: demo-skill", "name: Demo_Skill")
    );
    expect(codes(invalid)).toEqual(["name-invalid"]);

    const long = "a".repeat(65);
    const tooLong = createSkill(long);
    expect(codes(tooLong)).toEqual(["name-invalid"]);

    const mismatch = createSkill();
    editSkill(mismatch, (source) =>
      source.replace("name: demo-skill", "name: other-skill")
    );
    expect(checkSkill(mismatch).issues).toEqual([
      {
        code: "name-mismatch",
        message: "name other-skill must match its directory, demo-skill",
        path: "SKILL.md",
      },
    ]);
  });

  test("requires a description from 1 to 1,024 characters", () => {
    for (const description of ['""', '"   "', "x".repeat(1025)]) {
      const root = createSkill();
      editSkill(root, (source) =>
        source.replace(
          "description: Use when testing the skill check.",
          `description: ${description}`
        )
      );
      expect(codes(root)).toEqual(["description-invalid"]);
    }
    const atLimit = createSkill();
    editSkill(atLimit, (source) =>
      source.replace(
        "description: Use when testing the skill check.",
        `description: ${"x".repeat(1024)}`
      )
    );
    expect(codes(atLimit)).toEqual([]);
  });

  test("requires Claude Code and Codex to agree on user invocation", () => {
    const claudeOnly = createSkill();
    editSkill(claudeOnly, (source) =>
      source.replace(
        "name: demo-skill",
        "name: demo-skill\ndisable-model-invocation: true"
      )
    );
    expect(checkSkill(claudeOnly).issues).toEqual([
      {
        code: "invocation-mismatch",
        message:
          "disable-model-invocation is true, so agents/openai.yaml must set policy.allow_implicit_invocation: false",
        path: "SKILL.md",
      },
    ]);
    writeFixture(
      claudeOnly,
      "agents/openai.yaml",
      "interface:\n  display_name: Demo\npolicy:\n  allow_implicit_invocation: false\n"
    );
    expect(codes(claudeOnly)).toEqual([]);

    const codexOnly = createSkill();
    writeFixture(
      codexOnly,
      "agents/openai.yaml",
      "policy:\n  allow_implicit_invocation: false\n"
    );
    expect(codes(codexOnly)).toEqual(["invocation-mismatch"]);

    const modelInvoked = createSkill();
    writeFixture(
      modelInvoked,
      "agents/openai.yaml",
      'interface:\n  display_name: "Demo"\n'
    );
    expect(codes(modelInvoked)).toEqual([]);

    const broken = createSkill();
    writeFixture(broken, "agents/openai.yaml", "interface: [unclosed\n");
    expect(checkSkill(broken).issues).toMatchObject([
      { code: "openai-yaml", path: "agents/openai.yaml" },
    ]);
  });

  test("requires every relative link in SKILL.md and references to resolve", () => {
    const root = createSkill();
    editSkill(root, (source) =>
      source.replace("# Demo\n", "# Demo\n\nSee [gone](references/gone.md).\n")
    );
    writeFixture(
      root,
      "references/providers/one.md",
      "# One\n\nSee [missing](../missing.md#top).\n"
    );
    expect(checkSkill(root).issues).toEqual([
      {
        code: "link-broken",
        message: "link references/gone.md does not resolve to a file",
        path: "SKILL.md",
      },
      {
        code: "link-broken",
        message: "link ../missing.md#top does not resolve to a file",
        path: "references/providers/one.md",
      },
    ]);
  });

  test("a self-contained skill rejects a link that leaves its directory, directly or through a symlink", () => {
    const root = createSkill();
    const outside = join(root, "..", "outside.md");
    writeFileSync(outside, "# Outside\n");
    mkdirSync(join(root, "shared"), { recursive: true });
    symlinkSync(outside, join(root, "shared", "linked.md"));
    editSkill(root, (source) =>
      source.replace(
        "# Demo\n",
        "# Demo\n\nSee [outside](../outside.md) and [linked](shared/linked.md).\n"
      )
    );
    // A repository fork may link to its repository's other files.
    expect(codes(root)).toEqual([]);
    expect(
      checkSkill(root, { selfContained: true }).issues.map(
        (issue) => issue.code
      )
    ).toEqual(["link-escapes", "link-escapes"]);
  });

  test("the CLI checks a skill directory, or the skill that ships it", () => {
    const root = createSkill();
    const passed = runCli("skill", "check", "--skill-dir", root, "--json");
    expect(passed.exitCode).toBe(0);
    expect(JSON.parse(passed.stdout)).toMatchObject({
      name: "demo-skill",
      valid: true,
    });

    editSkill(root, (source) =>
      source.replace("name: demo-skill", "name: other-skill")
    );
    const failed = runCli("skill", "check", "--skill-dir", root);
    expect(failed.exitCode).toBe(3);
    expect(failed.stdout).toContain(
      "- SKILL.md: name other-skill must match its directory, demo-skill"
    );

    const own = runCli("skill", "check", "--json");
    expect(own.exitCode).toBe(0);
    expect(JSON.parse(own.stdout)).toMatchObject({
      name: "simple-changes",
      skillDirectory: resolve(repositoryRoot, "skills/simple-changes"),
    });
    expect(runCli("skill").exitCode).toBe(2);
  });
});
