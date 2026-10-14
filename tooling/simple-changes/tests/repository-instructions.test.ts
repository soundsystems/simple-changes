import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  discoverGlobalInstructionTargets,
  discoverInstructionTargets,
  discoverRepositoryInstructionTargets,
  inspectScratchFileRule,
  renderInstructionPointer,
  renderScratchFileRule,
  writeInstructionPointer,
  writeScratchFileRule,
} from "../../../skills/simple-changes/scripts/lib/repository-instructions.ts";
import { runningSkillName } from "../../../skills/simple-changes/scripts/lib/skill-roots.ts";
import {
  createTestRepository,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

const SCRATCH_FILE_BLOCK =
  /<!-- simple-changes:scratch-files:start -->\n[\s\S]*?\n<!-- simple-changes:scratch-files:end -->/u;

let repositories: TestRepository[] = [];

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

describe("repository instruction pointers", () => {
  test("discovers only existing root instruction files", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);

    expect(discoverInstructionTargets("repository", fixture.root)).toEqual([]);
    expect(() =>
      discoverInstructionTargets(
        "repository",
        fixture.root,
        "missing/AGENTS.md"
      )
    ).toThrow("refusing to create");

    writeFixture(fixture.root, "AGENTS.md", "# Agent guidance\n");
    expect(discoverInstructionTargets("repository", fixture.root)).toEqual([
      {
        path: resolve(fixture.root, "AGENTS.md"),
        scope: "repository",
      },
    ]);
  });

  test("updates one managed block in place without duplication", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(fixture.root, "AGENTS.md", "# Agent guidance\n");
    const [target] = discoverInstructionTargets("repository", fixture.root);
    if (!target) {
      throw new Error("Expected an instruction target");
    }

    const first = writeInstructionPointer(target, "confirm-ready");
    expect(first).toMatchObject({ changed: true, written: true });
    expect(readFileSync(target.path, "utf8")).toContain(
      "Is this ready for Simple Changes, or do you want more changes first?"
    );

    const second = writeInstructionPointer(target, "automatic");
    const contents = readFileSync(target.path, "utf8");
    expect(second).toMatchObject({ changed: true, written: true });
    expect(contents).toContain(
      "After an agent completes and verifies assigned implementation work"
    );
    expect(contents).not.toContain("Is this ready for Simple Changes");
    expect(contents.match(/<!-- simple-changes:start -->/gu)).toHaveLength(1);

    expect(writeInstructionPointer(target, "automatic")).toMatchObject({
      changed: false,
      written: false,
    });
  });

  test("keeps the scratch-file rule in its own block beside the pointer", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(fixture.root, "AGENTS.md", "# Agent guidance\n");
    const [target] = discoverInstructionTargets("repository", fixture.root);
    if (!target) {
      throw new Error("Expected an instruction target");
    }

    expect(writeScratchFileRule(target)).toMatchObject({
      changed: true,
      written: true,
    });
    writeInstructionPointer(target, "automatic");
    // Rewriting the pointer leaves the rule, and the rule is never repeated.
    writeInstructionPointer(target, "confirm-ready");
    expect(writeScratchFileRule(target)).toMatchObject({
      changed: false,
      written: false,
    });
    const contents = readFileSync(target.path, "utf8");
    expect(contents).toContain(renderScratchFileRule());
    expect(
      contents.match(/<!-- simple-changes:scratch-files:start -->/gu)
    ).toHaveLength(1);
    expect(contents.match(/<!-- simple-changes:start -->/gu)).toHaveLength(1);
    expect(renderScratchFileRule()).toContain(
      "never inside or next to a repository checkout"
    );
  });

  test("scopes the scratch-file rule to one folder per agent", () => {
    // The rule once said only to delete scratch files when the task ends.
    // A subagent sharing its parent's scratch directory followed it by
    // pattern and deleted the parent's drafts, so ownership is explicit.
    const rule = renderScratchFileRule();
    for (const phrase of [
      "only in one scratch folder of your own",
      "the folder your brief names, the work directory a Simple Changes run reports",
      "a new folder you create with `mktemp -d` under the session's scratch directory",
      "give it a folder inside yours and name the path in its brief",
      "delete exactly your own folder by its path",
      "never delete by pattern, extension, or age in a directory other agents share",
    ]) {
      expect(rule).toContain(phrase);
    }
    expect(rule).not.toContain("Delete them when the task ends");
  });

  test("reports whether a scratch-file block is current, stale, or absent", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(fixture.root, "AGENTS.md", "# Agent guidance\n");
    const [target] = discoverInstructionTargets("repository", fixture.root);
    if (!target) {
      throw new Error("Expected an instruction target");
    }
    expect(inspectScratchFileRule(target)).toBe("absent");
    writeScratchFileRule(target);
    expect(inspectScratchFileRule(target)).toBe("current");

    // An earlier release's text between the same markers is stale exactly
    // when the writer would change the file.
    const current = readFileSync(target.path, "utf8");
    const stale = current.replace(
      SCRATCH_FILE_BLOCK,
      "<!-- simple-changes:scratch-files:start -->\nDelete them when the task ends.\n<!-- simple-changes:scratch-files:end -->"
    );
    expect(stale).not.toBe(current);
    writeFileSync(target.path, stale);
    expect(inspectScratchFileRule(target)).toBe("stale");
    expect(writeScratchFileRule(target)).toMatchObject({
      changed: true,
      written: true,
    });
    expect(inspectScratchFileRule(target)).toBe("current");

    // CRLF files compare through the newline style the writer uses.
    writeFileSync(
      target.path,
      readFileSync(target.path, "utf8").replaceAll("\n", "\r\n")
    );
    expect(inspectScratchFileRule(target)).toBe("current");

    const block = renderScratchFileRule();
    writeFileSync(target.path, `${block}\n\n${block}\n`);
    expect(inspectScratchFileRule(target)).toBe("invalid");
  });

  test("finds the harnesses' global instruction files under the configured roots", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const home = join(fixture.base, "home");
    writeFixture(home, ".codex/AGENTS.md", "# Codex\n");
    writeFixture(home, ".claude/CLAUDE.md", "# Claude\n");
    const missingHome = join(fixture.base, "missing");
    expect(
      discoverGlobalInstructionTargets(
        { SIMPLE_CHANGES_HARNESS_ROOTS: home },
        missingHome
      )
    ).toEqual([
      { path: resolve(home, ".codex/AGENTS.md"), scope: "user" },
      { path: resolve(home, ".claude/CLAUDE.md"), scope: "user" },
    ]);
    // The home directory serves without the override, and the harnesses'
    // own location variables win over it.
    expect(discoverGlobalInstructionTargets({}, home)).toEqual([
      { path: resolve(home, ".codex/AGENTS.md"), scope: "user" },
      { path: resolve(home, ".claude/CLAUDE.md"), scope: "user" },
    ]);
    const codexHome = join(fixture.base, "codex-home");
    writeFixture(fixture.base, "codex-home/AGENTS.md", "# Codex elsewhere\n");
    expect(
      discoverGlobalInstructionTargets(
        { CODEX_HOME: codexHome, SIMPLE_CHANGES_HARNESS_ROOTS: home },
        missingHome
      )
    ).toEqual([
      { path: resolve(codexHome, "AGENTS.md"), scope: "user" },
      { path: resolve(home, ".claude/CLAUDE.md"), scope: "user" },
    ]);
    // A linked file is skipped, never followed, and an empty root lists
    // nothing.
    const linkedHome = join(fixture.base, "linked-home");
    writeFixture(linkedHome, ".codex/AGENTS.md", "# Codex\n");
    writeFixture(linkedHome, ".claude/REAL.md", "# Real\n");
    symlinkSync("REAL.md", resolve(linkedHome, ".claude/CLAUDE.md"));
    expect(
      discoverGlobalInstructionTargets(
        { SIMPLE_CHANGES_HARNESS_ROOTS: linkedHome },
        missingHome
      )
    ).toEqual([
      { path: resolve(linkedHome, ".codex/AGENTS.md"), scope: "user" },
    ]);
    expect(
      discoverGlobalInstructionTargets(
        { SIMPLE_CHANGES_HARNESS_ROOTS: missingHome },
        missingHome
      )
    ).toEqual([]);
  });

  test("inspects each repository instruction file on its own", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    expect(discoverRepositoryInstructionTargets(null)).toEqual([]);
    expect(discoverRepositoryInstructionTargets(fixture.root)).toEqual([]);

    // A CLAUDE.md linked to AGENTS.md makes setup refuse the repository
    // scope, but must not hide the regular AGENTS.md from inspection.
    writeFixture(fixture.root, "AGENTS.md", "# Agent guidance\n");
    symlinkSync("AGENTS.md", resolve(fixture.root, "CLAUDE.md"));
    expect(() =>
      discoverInstructionTargets("repository", fixture.root)
    ).toThrow("Refusing to update an instruction symlink");
    expect(discoverRepositoryInstructionTargets(fixture.root)).toEqual([
      { path: resolve(fixture.root, "AGENTS.md"), scope: "repository" },
    ]);

    // Either file may be the unsafe one.
    const reversed = createTestRepository();
    repositories.push(reversed);
    writeFixture(reversed.root, "CLAUDE.md", "# Claude guidance\n");
    mkdirSync(resolve(reversed.root, "AGENTS.md"));
    expect(discoverRepositoryInstructionTargets(reversed.root)).toEqual([
      { path: resolve(reversed.root, "CLAUDE.md"), scope: "repository" },
    ]);
  });

  test("refuses a duplicated scratch-file block", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const block = renderScratchFileRule();
    writeFixture(fixture.root, "AGENTS.md", `${block}\n\n${block}\n`);
    const [target] = discoverInstructionTargets("repository", fixture.root);
    if (!target) {
      throw new Error("Expected an instruction target");
    }

    expect(() => writeScratchFileRule(target)).toThrow(
      "invalid Simple Changes managed block"
    );
  });

  test("refuses managed blocks that nest or cross", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const pointer = renderInstructionPointer("repository", "automatic");
    const [pointerStart = "", pointerEnd = ""] = [
      pointer.split("\n")[0],
      pointer.split("\n").at(-1),
    ];
    const rule = renderScratchFileRule();
    const nested = `${pointerStart}\n${rule}\n${pointerEnd}\n`;
    const [ruleStart = "", , ruleEnd = ""] = rule.split("\n");
    const crossed = `${pointerStart}\n${ruleStart}\n${pointerEnd}\n${ruleEnd}\n`;
    for (const contents of [nested, crossed]) {
      writeFixture(fixture.root, "AGENTS.md", contents);
      const [target] = discoverInstructionTargets("repository", fixture.root);
      if (!target) {
        throw new Error("Expected an instruction target");
      }
      expect(() => writeInstructionPointer(target, "confirm-ready")).toThrow(
        "invalid Simple Changes managed block"
      );
      expect(() => writeScratchFileRule(target)).toThrow(
        "invalid Simple Changes managed block"
      );
      expect(readFileSync(target.path, "utf8")).toBe(contents);
    }
  });

  test("supports an explicit existing global instruction file", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(fixture.base, "profile/AGENTS.md", "# Global guidance\n");
    const path = resolve(fixture.base, "profile/AGENTS.md");

    expect(discoverInstructionTargets("user", null)).toEqual([]);
    expect(discoverInstructionTargets("user", null, path)).toEqual([
      { path, scope: "user" },
    ]);
    const [target] = discoverInstructionTargets("user", null, path);
    if (!target) {
      throw new Error("Expected a global instruction target");
    }
    writeInstructionPointer(target, "user-signaled");
    expect(readFileSync(path, "utf8")).toContain("the repository's own policy");
    expect(readFileSync(path, "utf8")).not.toContain(".simple-changes.json");
  });

  test("rejects symlinks and malformed managed blocks", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(fixture.root, "REAL.md", "# Real\n");
    symlinkSync("REAL.md", resolve(fixture.root, "AGENTS.md"));
    expect(() =>
      discoverInstructionTargets("repository", fixture.root)
    ).toThrow("symlink");

    writeFixture(
      fixture.root,
      "CLAUDE.md",
      "<!-- simple-changes:start -->\nFirst\n<!-- simple-changes:start -->\n"
    );
    const [target] = discoverInstructionTargets(
      "repository",
      fixture.root,
      "CLAUDE.md"
    );
    if (!target) {
      throw new Error("Expected an instruction target");
    }
    expect(() => writeInstructionPointer(target, "automatic")).toThrow(
      "invalid Simple Changes managed block"
    );
  });

  test("names the running skill, keeping the markers an existing block uses", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(fixture.root, "AGENTS.md", "# Agent guidance\n");
    const [target] = discoverInstructionTargets("repository", fixture.root);
    if (!target) {
      throw new Error("Expected an instruction target");
    }
    writeInstructionPointer(target, "automatic");
    expect(readFileSync(target.path, "utf8")).toContain(
      "use the `simple-changes` skill"
    );

    writeInstructionPointer(target, "automatic", "patrick-simple-changes");
    const contents = readFileSync(target.path, "utf8");
    expect(contents).toContain("use the `patrick-simple-changes` skill");
    expect(contents).not.toContain("the `simple-changes` skill");
    expect(contents.match(/<!-- simple-changes:start -->/gu)).toHaveLength(1);
    expect(contents.match(/<!-- simple-changes:end -->/gu)).toHaveLength(1);
    // A user-level file spans repositories and keeps the generic wording.
    expect(
      renderInstructionPointer("user", "automatic", "patrick-simple-changes")
    ).toContain("the applicable `simple-changes` skill");
  });
});

describe("running skill name", () => {
  const canonicalScripts = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../skills/simple-changes/scripts"
  );
  const skill = (name: string) =>
    `---\nname: ${name}\ndescription: Fixture skill.\n---\n\n# Fixture\n`;

  // Copies the real runtime into a skill layout, then renders the pointer
  // from that copy so the default name comes from where the runtime lives.
  const layout = (
    base: string,
    name: string,
    scriptsPath: string,
    declaredName: string | null = name
  ): string => {
    const root = join(base, name);
    mkdirSync(root, { recursive: true });
    if (declaredName !== null) {
      writeFileSync(join(root, "SKILL.md"), skill(declaredName));
    }
    const scripts = join(root, scriptsPath);
    cpSync(canonicalScripts, scripts, { recursive: true });
    return scripts;
  };

  const renderFrom = async (scripts: string): Promise<string> => {
    const module = (await import(
      pathToFileURL(join(scripts, "lib/repository-instructions.ts")).href
    )) as typeof import("../../../skills/simple-changes/scripts/lib/repository-instructions.ts");
    return module.renderInstructionPointer("repository", "automatic");
  };

  test("the canonical runtime names simple-changes", () => {
    expect(runningSkillName(join(canonicalScripts, "simple-changes.ts"))).toBe(
      "simple-changes"
    );
    expect(renderInstructionPointer("repository", "automatic")).toContain(
      "use the `simple-changes` skill"
    );
  });

  test("a plain fork layout names the fork", async () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const scripts = layout(fixture.base, "patrick-simple-changes", "scripts");
    expect(runningSkillName(join(scripts, "simple-changes.ts"))).toBe(
      "patrick-simple-changes"
    );
    expect(await renderFrom(scripts)).toContain(
      "use the `patrick-simple-changes` skill"
    );
  });

  test("a runtime-directory fork layout names the fork", async () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const scripts = layout(
      fixture.base,
      "thor-simple-changes",
      "runtime/scripts"
    );
    expect(runningSkillName(join(scripts, "simple-changes.ts"))).toBe(
      "thor-simple-changes"
    );
    expect(await renderFrom(scripts)).toContain(
      "use the `thor-simple-changes` skill"
    );
  });

  test.each([
    ['"thor-simple-changes extra"', "simple-changes"],
    ["thor-simple-changes extra", "simple-changes"],
    ['"unterminated-fork', "simple-changes"],
    ['"escaped\\"-fork"', "simple-changes"],
    ['"quoted-fork"', "quoted-fork"],
    ["'single-quoted-fork'", "single-quoted-fork"],
    ['"commented-fork" # trailing comment', "commented-fork"],
    ["plain-fork # trailing comment", "plain-fork"],
    ["   padded-fork   ", "padded-fork"],
    ["fork-", "simple-changes"],
    ["fork--name", "simple-changes"],
  ])("reads the complete name scalar %s as %s", (declared, expected) => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const root = join(fixture.base, "declared");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "SKILL.md"), skill(declared));
    expect(runningSkillName(join(root, "scripts", "simple-changes.ts"))).toBe(
      expected
    );
  });

  test("falls back to simple-changes without a usable SKILL.md name", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const missing = layout(fixture.base, "unnamed", "scripts", null);
    expect(runningSkillName(join(missing, "simple-changes.ts"))).toBe(
      "simple-changes"
    );
    const unsafe = layout(fixture.base, "unsafe", "scripts", "bad`name");
    expect(runningSkillName(join(unsafe, "simple-changes.ts"))).toBe(
      "simple-changes"
    );
  });
});
