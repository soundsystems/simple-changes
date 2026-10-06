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
  discoverInstructionTargets,
  renderInstructionPointer,
  writeInstructionPointer,
} from "../../../skills/simple-changes/scripts/lib/repository-instructions.ts";
import { runningSkillName } from "../../../skills/simple-changes/scripts/lib/skill-roots.ts";
import {
  createTestRepository,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

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
