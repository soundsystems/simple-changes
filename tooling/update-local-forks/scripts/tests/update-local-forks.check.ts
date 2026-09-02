#!/usr/bin/env bun

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "bun";
import {
  applyForkPlan,
  discover,
  inspectFork,
  planForkUpdate,
} from "../../../../skills/update-local-forks/scripts/update-local-forks.ts";

const skillRoot = resolve(
  import.meta.dir,
  "../../../../skills/update-local-forks"
);
const cliPath = join(skillRoot, "scripts", "update-local-forks.ts");
const decoder = new TextDecoder();
setDefaultTimeout(120_000);
let scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch) {
    rmSync(directory, { force: true, recursive: true });
  }
  scratch = [];
});

const git = (cwd: string, args: string[]): string => {
  const result = spawnSync(["git", "-C", cwd, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${decoder.decode(result.stderr)}`
    );
  }
  return decoder.decode(result.stdout).trim();
};

const write = (root: string, relativePath: string, contents: string): void => {
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
};

interface Fixture {
  base: string;
  fork: string;
  pin: string;
  release: string;
  source: string;
  upstream: string;
}

/**
 * Build a tiny canonical repository with two commits: the pin the fork was
 * cut from, and a later release. The installed source is the release tree.
 * The fork uses the runtime-directory layout, edits prose, drops one
 * reference, and keeps its own test script pinning upstream literals.
 */
const createFixture = (): Fixture => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "update-local-forks-")));
  scratch.push(base);
  const upstream = join(base, "upstream");
  mkdirSync(upstream);
  git(upstream, ["init", "-q", "-b", "main"]);
  git(upstream, ["config", "user.name", "Fixture"]);
  git(upstream, ["config", "user.email", "fixture@example.invalid"]);
  const skill = "skills/simple-changes";
  write(
    upstream,
    `${skill}/SKILL.md`,
    "---\nname: simple-changes\n---\n\n# Simple Changes\n\nIntro line.\n\n## Rules\n\nRule one.\n"
  );
  write(
    upstream,
    `${skill}/SPEC.md`,
    "# Spec\n\n- guarantee a\n- guarantee b\n"
  );
  write(
    upstream,
    `${skill}/CHANGELOG.md`,
    "# Changelog\n\n## 0.1.0 - 2026-01-01\n\n- first\n"
  );
  write(upstream, `${skill}/references/sync.md`, "# Sync\n\nStep one.\n");
  write(
    upstream,
    `${skill}/references/deployments.md`,
    "# Deployments\n\nDeploy carefully.\n"
  );
  write(upstream, `${skill}/references/obsolete.md`, "# Obsolete\n");
  write(
    upstream,
    `${skill}/scripts/lib/guidance-updates.ts`,
    "export const CURRENT_GUIDANCE_VERSION = 1;\n"
  );
  write(upstream, `${skill}/scripts/lib/core.ts`, "export const core = 1;\n");
  write(
    upstream,
    `${skill}/evals/schemas/policy.schema.json`,
    '{"version":1}\n'
  );
  git(upstream, ["add", "."]);
  git(upstream, [
    "commit",
    "-q",
    "-m",
    "chore(release): Publish Simple Changes 0.1.0",
  ]);
  const pin = git(upstream, ["rev-parse", "HEAD"]);

  // The fork: runtime layout, its own prose, one reference omitted, a
  // fork-only wrapper and test script pinning upstream literals.
  const fork = join(base, "project", "skills", "acme-simple-changes");
  mkdirSync(fork, { recursive: true });
  git(join(base, "project"), ["init", "-q", "-b", "main"]);
  write(
    fork,
    "SKILL.md",
    `---\nname: acme-simple-changes\n---\n\n# Acme Simple Changes\n\nForked from \`simple-changes\` @ \`${pin}\`. Acme-specific deltas: GitLab only.\n\nIntro line.\n\n## Rules\n\nRule one.\n\n## Acme rules\n\nAlways sign.\n`
  );
  write(
    fork,
    "SPEC.md",
    "# Spec\n\n- guarantee a\n- guarantee b\n- acme guarantee\n"
  );
  write(fork, "references/sync.md", "# Sync\n\nStep one.\n");
  write(fork, "references/obsolete.md", "# Obsolete\n");
  write(
    fork,
    "runtime/scripts/lib/guidance-updates.ts",
    "export const CURRENT_GUIDANCE_VERSION = 1;\n"
  );
  write(fork, "runtime/scripts/lib/core.ts", "export const core = 1;\n");
  write(fork, "runtime/evals/schemas/policy.schema.json", '{"version":1}\n');
  write(
    fork,
    "scripts/simple-changes-runtime.sh",
    '#!/bin/sh\nexec bun runtime/scripts/simple-changes.ts "$@"\n'
  );
  write(
    fork,
    "scripts/test.sh",
    `#!/bin/sh\ngrep -q 'Forked from \`simple-changes\` @ \`${pin}\`' SKILL.md\ngrep -q 'CURRENT_GUIDANCE_VERSION = 1' runtime/scripts/lib/guidance-updates.ts\ngrep -q 'Simple Changes 0.1.0' notes.md\n`
  );
  write(fork, "notes.md", "Bundled Simple Changes 0.1.0.\n");

  // The release: prose edited on other lines, spec appended, a runtime file
  // changed, a new runtime file, a reference removed, a new reference, a
  // guidance bump, and a new changelog entry.
  write(
    upstream,
    `${skill}/SKILL.md`,
    "---\nname: simple-changes\n---\n\n# Simple Changes\n\nIntro line, revised.\n\n## Rules\n\nRule one.\n"
  );
  write(
    upstream,
    `${skill}/SPEC.md`,
    "# Spec\n\n- guarantee a\n- guarantee b\n- guarantee c\n"
  );
  write(
    upstream,
    `${skill}/CHANGELOG.md`,
    "# Changelog\n\n## 0.2.0 - 2026-02-01\n\n- second\n\n## 0.1.0 - 2026-01-01\n\n- first\n"
  );
  write(
    upstream,
    `${skill}/references/deployments.md`,
    "# Deployments\n\nDeploy very carefully.\n"
  );
  write(upstream, `${skill}/references/signatures.md`, "# Signatures\n");
  rmSync(join(upstream, skill, "references", "obsolete.md"));
  write(
    upstream,
    `${skill}/scripts/lib/guidance-updates.ts`,
    "export const CURRENT_GUIDANCE_VERSION = 2;\n"
  );
  write(upstream, `${skill}/scripts/lib/core.ts`, "export const core = 2;\n");
  write(
    upstream,
    `${skill}/scripts/lib/extra.ts`,
    "export const extra = true;\n"
  );
  git(upstream, ["add", "-A"]);
  git(upstream, [
    "commit",
    "-q",
    "-m",
    "chore(release): Publish Simple Changes 0.2.0",
  ]);
  const release = git(upstream, ["rev-parse", "HEAD"]);

  const source = join(base, "global", "skills", "simple-changes");
  mkdirSync(source, { recursive: true });
  cpSync(join(upstream, skill), source, { recursive: true });
  return { base, fork, pin, release, source, upstream };
};

describe("update-local-forks", () => {
  test("discovers installed sources and forks, flagging linked worktrees", () => {
    const fixture = createFixture();
    git(join(fixture.base, "project"), ["config", "user.name", "Fixture"]);
    git(join(fixture.base, "project"), [
      "config",
      "user.email",
      "f@example.invalid",
    ]);
    git(join(fixture.base, "project"), ["add", "."]);
    git(join(fixture.base, "project"), ["commit", "-q", "-m", "fork"]);
    const linked = join(fixture.base, "linked");
    git(join(fixture.base, "project"), ["worktree", "add", "-q", linked]);

    const result = discover({ home: fixture.base, roots: [fixture.base] });

    const sourcePaths = result.sources.map((source) => source.path);
    expect(sourcePaths).toContain(realpathSync(fixture.source));
    expect(
      result.sources.find(
        (source) => source.path === realpathSync(fixture.source)
      )
    ).toMatchObject({
      guidanceVersion: 2,
      version: "0.2.0",
    });
    const forks = result.forks.map((fork) => ({
      linked: fork.repository?.linkedWorktree ?? null,
      name: fork.name,
      path: fork.path,
    }));
    expect(forks).toContainEqual({
      linked: false,
      name: "acme-simple-changes",
      path: realpathSync(fixture.fork),
    });
    expect(forks).toContainEqual({
      linked: true,
      name: "acme-simple-changes",
      path: realpathSync(join(linked, "skills", "acme-simple-changes")),
    });
    expect(inspectFork(fixture.source)).toBeNull();
  });

  test("plans and applies an update that keeps every fork delta", () => {
    const fixture = createFixture();
    const plan = planForkUpdate({
      fork: fixture.fork,
      source: fixture.source,
      upstream: fixture.upstream,
    });

    const byPath = Object.fromEntries(
      plan.entries.map((entry) => [entry.forkPath, entry.action])
    );
    expect(plan.source).toMatchObject({
      commit: fixture.release,
      commitVerified: true,
      version: "0.2.0",
    });
    expect(plan.pinUpdate).toMatchObject({
      from: fixture.pin,
      to: fixture.release,
    });
    expect(byPath).toMatchObject({
      "notes.md": "keep-fork-only",
      "references/deployments.md": "review",
      "references/obsolete.md": "delete",
      "references/signatures.md": "review",
      "references/sync.md": "current",
      "runtime/evals/schemas/policy.schema.json": "current",
      "runtime/scripts/lib/core.ts": "update",
      "runtime/scripts/lib/extra.ts": "add",
      "runtime/scripts/lib/guidance-updates.ts": "update",
      "SKILL.md": "merge",
      "SPEC.md": "conflict",
      "scripts/simple-changes-runtime.sh": "keep-fork-only",
    });
    expect(
      plan.entries.find((entry) => entry.upstreamPath === "CHANGELOG.md")
        ?.action
    ).toBe("skip");
    expect(plan.literalRewrites).toHaveLength(4);
    expect(
      plan.literalRewrites.some((rewrite) => rewrite.to === fixture.release)
    ).toBe(true);

    const receipt = applyForkPlan(plan);

    expect(receipt.conflicts).toEqual(["SPEC.md"]);
    expect(receipt.deleted).toEqual(["references/obsolete.md"]);
    expect([...receipt.review].sort((a, b) => a.localeCompare(b))).toEqual([
      "references/deployments.md",
      "references/signatures.md",
    ]);
    const skill = readFileSync(join(fixture.fork, "SKILL.md"), "utf8");
    expect(skill).toContain(
      `Forked from \`simple-changes\` @ \`${fixture.release}\``
    );
    const sidecar = readFileSync(
      join(fixture.fork, "SPEC.md.upstream-merge"),
      "utf8"
    );
    expect(sidecar).toContain("<<<<<<< fork");
    expect(sidecar).toContain(">>>>>>> installed upstream");
    expect(skill).toContain("Intro line, revised.");
    expect(skill).toContain("## Acme rules");
    const spec = readFileSync(join(fixture.fork, "SPEC.md"), "utf8");
    expect(spec).toContain("acme guarantee");
    expect(spec).not.toContain("guarantee c");
    expect(
      readFileSync(join(fixture.fork, "runtime/scripts/lib/core.ts"), "utf8")
    ).toBe("export const core = 2;\n");
    expect(existsSync(join(fixture.fork, "runtime/scripts/lib/extra.ts"))).toBe(
      true
    );
    expect(existsSync(join(fixture.fork, "references/obsolete.md"))).toBe(
      false
    );
    expect(existsSync(join(fixture.fork, "references/signatures.md"))).toBe(
      false
    );
    const testScript = readFileSync(
      join(fixture.fork, "scripts/test.sh"),
      "utf8"
    );
    expect(testScript).toContain(fixture.release);
    expect(testScript).not.toContain(fixture.pin);
    expect(testScript).toContain("CURRENT_GUIDANCE_VERSION = 2");
    expect(readFileSync(join(fixture.fork, "notes.md"), "utf8")).toBe(
      "Bundled Simple Changes 0.2.0.\n"
    );

    // Until the sidecar is merged and deleted, the file stays a review item;
    // afterwards the plan is a no-op.
    const pending = planForkUpdate({
      fork: fixture.fork,
      source: fixture.source,
      upstream: fixture.upstream,
    });
    expect(pending.summary).toMatchObject({ conflict: 0, merge: 0, update: 0 });
    expect(
      pending.entries.find((entry) => entry.forkPath === "SPEC.md")
    ).toMatchObject({ action: "review" });
    expect(
      pending.entries.some((entry) =>
        entry.forkPath.endsWith(".upstream-merge")
      )
    ).toBe(false);
    writeFileSync(
      join(fixture.fork, "SPEC.md"),
      "# Spec\n\n- guarantee a\n- guarantee b\n- guarantee c\n- acme guarantee\n"
    );
    rmSync(join(fixture.fork, "SPEC.md.upstream-merge"));
    const settled = planForkUpdate({
      fork: fixture.fork,
      source: fixture.source,
      upstream: fixture.upstream,
    });
    expect(settled.summary).toMatchObject({
      add: 0,
      conflict: 0,
      delete: 0,
      merge: 0,
      omitted: 2,
      review: 0,
      update: 0,
    });
    expect(
      settled.entries.find((entry) => entry.forkPath === "SPEC.md")
    ).toMatchObject({ action: "keep-fork-delta" });
    expect(settled.literalRewrites).toEqual([]);
  });

  test("refuses to apply a plan after the fork changed and refuses an unverified pin", () => {
    const fixture = createFixture();
    const plan = planForkUpdate({
      fork: fixture.fork,
      source: fixture.source,
      upstream: fixture.upstream,
    });
    writeFileSync(
      join(fixture.fork, "runtime/scripts/lib/core.ts"),
      "export const core = 99;\n"
    );
    expect(() => applyForkPlan(plan)).toThrow(
      "changed after the plan was made"
    );

    // Drift the installed source away from the release tree: the pin stays.
    writeFileSync(
      join(fixture.source, "SPEC.md"),
      "# Spec\n\n- edited locally\n"
    );
    const drifted = planForkUpdate({
      fork: fixture.fork,
      source: fixture.source,
      upstream: fixture.upstream,
    });
    expect(drifted.pinUpdate.to).toBeNull();
    expect(drifted.source.commitVerified).toBe(false);
    expect(
      drifted.literalRewrites.some((rewrite) => rewrite.to === fixture.release)
    ).toBe(false);
  });

  test("the CLI plans, applies, and reports through JSON", () => {
    const fixture = createFixture();
    const planned = spawnSync(
      [
        process.execPath,
        cliPath,
        "plan",
        "--fork",
        fixture.fork,
        "--source",
        fixture.source,
        "--upstream",
        fixture.upstream,
        "--json",
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(planned.exitCode).toBe(3);
    const planPath = join(fixture.base, "plan.json");
    writeFileSync(planPath, decoder.decode(planned.stdout));
    const applied = spawnSync(
      [process.execPath, cliPath, "apply", "--plan", planPath, "--json"],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(applied.exitCode).toBe(3);
    expect(JSON.parse(decoder.decode(applied.stdout))).toMatchObject({
      conflicts: ["SPEC.md"],
      pin: { from: fixture.pin, to: fixture.release },
    });
    const help = spawnSync([process.execPath, cliPath, "help"], {
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(decoder.decode(help.stdout)).toContain(
      "update-local-forks discover"
    );
  });

  test("the package documents the workflow it ships", () => {
    const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
    const reference = readFileSync(
      join(skillRoot, "references", "fork-sync.md"),
      "utf8"
    );
    for (const required of [
      "discover",
      "plan",
      "apply",
      "linked Git",
      "never commits",
      "byte-identical",
    ]) {
      expect(skill).toContain(required);
    }
    for (const action of [
      "keep-fork-delta",
      "conflict",
      "review",
      "keep-fork-only",
      "skip",
    ]) {
      expect(reference).toContain(action);
    }
    expect(reference).toContain("--skill update-local-forks");
  });
});
