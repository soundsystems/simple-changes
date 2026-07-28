import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import {
  discoverInstructionTargets,
  writeInstructionPointer,
} from "../../../skills/simple-changes/scripts/lib/repository-instructions.ts";
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
});
