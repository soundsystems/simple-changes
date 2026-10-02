import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "bun";
import { createFork } from "../../../skills/simple-changes/scripts/lib/fork.ts";
import { inspectFork } from "../../../skills/update-local-forks/scripts/update-local-forks.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

const repositories: TestRepository[] = [];
const fixture = () => {
  const upstream = createTestRepository();
  const target = createTestRepository();
  repositories.push(upstream, target);
  const sourcePath = join(upstream.root, "skills/simple-changes");
  mkdirSync(sourcePath, { recursive: true });
  writeFixture(
    sourcePath,
    "SKILL.md",
    "---\nname: simple-changes\ndescription: Fixture\n---\n\n# Simple Changes\n\nPortable guidance.\n"
  );
  writeFixture(
    sourcePath,
    "CHANGELOG.md",
    "# Changelog\n\n## 1.0.0 - 2026-10-01\n\nFixture release.\n"
  );
  writeFixture(
    sourcePath,
    "scripts/example.ts",
    "#!/usr/bin/env bun\nconsole.log('fixture');\n"
  );
  chmodSync(join(sourcePath, "scripts/example.ts"), 0o755);
  writeFixture(sourcePath, "references/example.md", "Reference content\n");
  git(upstream.root, ["add", "."]);
  git(upstream.root, ["commit", "-m", "Release 1.0.0"]);
  return {
    options: {
      deltas: "Product-specific release gates",
      name: "product-simple-changes",
      repositoryPath: target.root,
      sourcePath,
      upstreamPath: upstream.root,
    },
    target,
    upstream,
  };
};

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    repository.cleanup();
  }
});

describe("fork create", () => {
  test("copies the complete release with a verified pin, distinct identity, and executable permissions", () => {
    const { options, upstream } = fixture();
    const source = readFileSync(join(options.sourcePath, "SKILL.md"), "utf8");
    const result = createFork(options);
    expect(result.upstreamCommit).toBe(
      git(upstream.root, ["rev-parse", "HEAD"])
    );
    expect(result.fileCount).toBe(4);
    expect(
      readFileSync(join(result.destination, "SKILL.md"), "utf8")
    ).toContain(
      `Forked from \`simple-changes\` @ \`${result.upstreamCommit}\`. Fork-specific deltas: ${options.deltas}`
    );
    expect(
      readFileSync(join(result.destination, "SKILL.md"), "utf8")
    ).toContain("name: product-simple-changes");
    expect(
      readFileSync(join(result.destination, "scripts/example.ts"))
    ).toEqual(readFileSync(join(options.sourcePath, "scripts/example.ts")));
    expect(
      statSync(join(result.destination, "scripts/example.ts")).mode % 0o1000
    ).toBe(0o755);
    expect(
      readFileSync(join(result.destination, "references/example.md"), "utf8")
    ).toBe("Reference content\n");
    expect(readFileSync(join(options.sourcePath, "SKILL.md"), "utf8")).toBe(
      source
    );
    expect(git(options.repositoryPath, ["log", "--oneline"])).toContain(
      "Initial fixture"
    );
  });

  test("refuses an existing fork without changing it", () => {
    const { options } = fixture();
    const first = createFork(options);
    writeFileSync(
      join(first.destination, "custom.txt"),
      "Keep this customization\n"
    );
    expect(() => createFork(options)).toThrow("Destination already exists");
    expect(readFileSync(join(first.destination, "custom.txt"), "utf8")).toBe(
      "Keep this customization\n"
    );
  });

  test("rejects a modified source rather than inventing a provenance pin", () => {
    const { options } = fixture();
    writeFixture(
      options.sourcePath,
      "scripts/example.ts",
      "Changed after release\n"
    );
    expect(() => createFork(options)).toThrow(
      "does not match an upstream commit"
    );
    expect(existsSync(join(options.repositoryPath, ".agents"))).toBe(false);
  });

  test("accepts committed skill updates between releases and records their exact commit", () => {
    const { options, upstream } = fixture();
    writeFixture(
      options.sourcePath,
      "references/example.md",
      "Updated upstream guidance\n"
    );
    git(upstream.root, ["add", "."]);
    git(upstream.root, ["commit", "-m", "Update guidance between releases"]);
    expect(createFork(options).upstreamCommit).toBe(
      git(upstream.root, ["rev-parse", "HEAD"])
    );
  });

  test("rejects untracked additions", () => {
    const { options } = fixture();
    writeFixture(options.sourcePath, "untracked.md", "Extra content\n");
    expect(() => createFork(options)).toThrow(
      "does not match an upstream commit"
    );
  });

  test("rejects an incomplete installation", () => {
    const { options } = fixture();
    rmSync(join(options.sourcePath, "references/example.md"));
    expect(() => createFork(options)).toThrow(
      "does not match an upstream commit"
    );
  });

  test("CLI creates a runnable fork that the public updater recognizes", () => {
    const { options, upstream } = fixture();
    const installedSource = new URL(
      "../../../skills/simple-changes/",
      import.meta.url
    );
    rmSync(options.sourcePath, { recursive: true });
    cpSync(installedSource, options.sourcePath, { recursive: true });
    git(upstream.root, ["add", "."]);
    git(upstream.root, [
      "commit",
      "-m",
      "Install current runtime release fixture",
    ]);
    const cli = join(options.sourcePath, "scripts/simple-changes.ts");
    const result = spawnSync([
      process.execPath,
      cli,
      "fork",
      "create",
      "--name",
      options.name,
      "--deltas",
      options.deltas,
      "--upstream",
      upstream.root,
      "--repo",
      options.repositoryPath,
      "--json",
    ]);
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
    const created = JSON.parse(new TextDecoder().decode(result.stdout));
    expect(inspectFork(created.destination)?.pin).toBe(created.upstreamCommit);
    const help = spawnSync([
      process.execPath,
      join(created.destination, "scripts/simple-changes.ts"),
      "--help",
    ]);
    expect(help.exitCode).toBe(0);
    expect(new TextDecoder().decode(help.stdout)).toContain(
      "simple-changes fork create"
    );
    const inventory = spawnSync([
      process.execPath,
      join(created.destination, "scripts/simple-changes.ts"),
      "inventory",
      "--repo",
      options.repositoryPath,
      "--json",
    ]);
    expect(inventory.exitCode).toBe(0);
    expect(
      JSON.parse(new TextDecoder().decode(inventory.stdout)).repository.root
    ).toBe(options.repositoryPath);
  });

  test("rejects invalid names and empty customization notes before writing", () => {
    const { options } = fixture();
    for (const name of [
      "simple-changes",
      "../outside",
      "MixedCase",
      "bad--name",
      "a".repeat(65),
    ]) {
      expect(() => createFork({ ...options, name })).toThrow("--name must be");
    }
    expect(() => createFork({ ...options, deltas: " \n " })).toThrow(
      "--deltas must describe"
    );
    expect(existsSync(join(options.repositoryPath, ".agents"))).toBe(false);
  });

  test("refuses traversal, source overlap, destination symlinks, and symlink parents", () => {
    const { options, target } = fixture();
    expect(() => createFork({ ...options, destination: "../outside" })).toThrow(
      "inside the repository"
    );
    expect(() =>
      createFork({
        ...options,
        destination: "skills/simple-changes/nested",
        repositoryPath: options.upstreamPath,
      })
    ).toThrow("separate from the source");
    symlinkSync(options.sourcePath, join(target.root, "fork"));
    expect(() => createFork({ ...options, destination: "fork" })).toThrow(
      "Destination already exists"
    );
    symlinkSync(options.sourcePath, join(target.root, ".agents"));
    expect(() => createFork(options)).toThrow("real directory");
    expect(existsSync(join(options.sourcePath, "skills"))).toBe(false);
  });

  test("rejects symlinks within the installed source", () => {
    const { options } = fixture();
    symlinkSync(
      join(options.sourcePath, "SKILL.md"),
      join(options.sourcePath, "linked.md")
    );
    expect(() => createFork(options)).toThrow("symlink or special file");
  });

  test("preserves literal customization text and supports an explicit repository-local destination", () => {
    const { options } = fixture();
    const result = createFork({
      ...options,
      deltas: "Literal $& and $`\nrelease notes",
      destination: "skills/product-simple-changes",
    });
    expect(
      readFileSync(join(result.destination, "SKILL.md"), "utf8")
    ).toContain("Fork-specific deltas: Literal $& and $` release notes");
  });
  test("anchors the fork at the repository root and refuses a non-repository", () => {
    const { options, target } = fixture();
    const nested = join(target.root, "sub/dir");
    mkdirSync(nested, { recursive: true });
    const result = createFork({ ...options, repositoryPath: nested });
    expect(result.destination).toBe(
      join(target.root, ".agents/skills/product-simple-changes")
    );
    const outside = join(target.base, "not-a-repo");
    mkdirSync(outside);
    expect(() =>
      createFork({
        ...options,
        name: "other-simple-changes",
        repositoryPath: outside,
      })
    ).toThrow("A fork belongs to a repository");
    expect(existsSync(join(outside, ".agents"))).toBe(false);
    expect(() =>
      createFork({
        ...options,
        name: "other-simple-changes",
        repositoryPath: join(target.base, "missing"),
      })
    ).toThrow("--repo does not exist");
  });

  test("refuses a differently cased destination that resolves into the source", () => {
    const { options, upstream } = fixture();
    const probe = join(upstream.root, "SKILLS");
    if (!existsSync(probe)) {
      return; // case-sensitive filesystem: the alias cannot exist
    }
    expect(() =>
      createFork({
        ...options,
        destination: "Skills/Simple-Changes/nested",
        repositoryPath: upstream.root,
      })
    ).toThrow("separate from the source skill");
    expect(existsSync(join(options.sourcePath, "nested"))).toBe(false);
  });

  test("names mismatching files, ignores Finder metadata, and checks --upstream", () => {
    const { options } = fixture();
    writeFileSync(join(options.sourcePath, ".DS_Store"), "finder");
    writeFileSync(join(options.sourcePath, "stray.txt"), "stray\n");
    expect(() => createFork(options)).toThrow("extra stray.txt");
    rmSync(join(options.sourcePath, "stray.txt"));
    expect(createFork(options).fileCount).toBe(4);
    expect(() =>
      createFork({
        ...options,
        name: "other-simple-changes",
        upstreamPath: "/nonexistent/upstream",
      })
    ).toThrow("--upstream must be a Simple Changes Git checkout");
  });

  test("refuses a name that matches an installed sibling skill", () => {
    const { options, upstream } = fixture();
    mkdirSync(join(upstream.root, "skills/update-local-forks"));
    expect(() =>
      createFork({ ...options, name: "update-local-forks" })
    ).toThrow("must not match an installed skill");
  });

  test("explains Windows line endings instead of misreporting a fork", () => {
    const { options } = fixture();
    const skill = join(options.sourcePath, "SKILL.md");
    writeFileSync(skill, readFileSync(skill, "utf8").replaceAll("\n", "\r\n"));
    expect(() => createFork(options)).toThrow("Windows line endings");
  });
});
