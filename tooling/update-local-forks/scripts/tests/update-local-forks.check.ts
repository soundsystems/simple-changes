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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "bun";
import {
  applyForkPlan,
  discover,
  inspectFork,
  intentionalOmissions,
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

/** A CLI whose documented and answered command surfaces both list `commands`. */
const cliSource = (commands: string[]): string => {
  const help = commands.map(
    (command) => `  simple-changes ${command} [--json]`
  );
  const cases = commands.map(
    (command) => `    case "${command}":\n      return 0;`
  );
  return [
    "const HELP = `Usage:",
    ...help,
    "`;",
    "",
    "export const executeCommand = (command: string): number => {",
    "  switch (command) {",
    ...cases,
    "    default:",
    "      return 2;",
    "  }",
    "};",
    "",
  ].join("\n");
};

const OMISSION_RECORD = [
  "# Acme fork maintenance",
  "",
  "## Intentional omissions",
  "",
  "- `references/deployments.md`: Acme deploys through its own pipeline.",
  "- `references/signatures.md`: Acme proposals carry no agent signatures.",
  "",
].join("\n");

const PINNED_COMMANDS = ["help", "initialize", "loop", "worktree"];
const RELEASED_COMMANDS = [...PINNED_COMMANDS, "prune"];

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
    `${skill}/scripts/simple-changes.ts`,
    cliSource(PINNED_COMMANDS)
  );
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
  const fork = join(
    base,
    "Developer",
    "project",
    "skills",
    "acme-simple-changes"
  );
  mkdirSync(fork, { recursive: true });
  git(join(base, "Developer", "project"), ["init", "-q", "-b", "main"]);
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
  write(fork, "runtime/scripts/simple-changes.ts", cliSource(PINNED_COMMANDS));
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
  // The fork records why it leaves out two upstream references; without the
  // record, a changed or new upstream reference holds the pin.
  write(fork, "references/fork-maintenance.md", OMISSION_RECORD);

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
    `${skill}/scripts/simple-changes.ts`,
    cliSource(RELEASED_COMMANDS)
  );
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
    const project = join(fixture.base, "Developer", "project");
    git(project, ["config", "user.name", "Fixture"]);
    git(project, ["config", "user.email", "f@example.invalid"]);
    git(project, ["add", "."]);
    git(project, ["commit", "-q", "-m", "fork"]);
    const linked = join(fixture.base, "linked");
    git(project, ["worktree", "add", "-q", linked]);

    const result = discover({ home: fixture.base, roots: [fixture.base] });
    const defaults = discover({ home: fixture.base, roots: [] });

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
    expect(defaults.forks.map((fork) => fork.path)).toContain(
      realpathSync(fixture.fork)
    );
  });

  test("reports a fork-owned command gate that a new upstream command escapes", () => {
    const fixture = createFixture();
    // The shape that shipped broken: the wrapper refuses anything outside its
    // own allowlist, and the allowlist was written against the pinned surface.
    write(
      fixture.fork,
      "scripts/simple-changes-runtime.sh",
      [
        "#!/bin/sh",
        "# Bundled Simple Changes 0.1.0",
        'case "$1" in',
        "  help | initialize | loop | worktree) ;;",
        "  *)",
        "    echo 'error: this fork permits only initialize, loop and worktree' >&2",
        "    exit 64",
        "    ;;",
        "esac",
        'exec bun runtime/scripts/simple-changes.ts "$@"',
        "",
      ].join("\n")
    );

    const skillPath = join(fixture.fork, "SKILL.md");
    writeFileSync(
      skillPath,
      `${readFileSync(skillPath, "utf8")}\nBundled Simple Changes 0.1.0.\n`
    );

    const plan = planForkUpdate({
      fork: fixture.fork,
      source: fixture.source,
      upstream: fixture.upstream,
    });
    const gate = plan.entries.find(
      (entry) => entry.forkPath === "scripts/simple-changes-runtime.sh"
    );

    expect(gate?.action).toBe("review");
    expect(gate?.reason).toContain("prune");
    // The vendored runtime still updates cleanly; only the gate is reported.
    expect(
      plan.entries.find(
        (entry) => entry.forkPath === "runtime/scripts/simple-changes.ts"
      )?.action
    ).toBe("update");
    const gateBefore = readFileSync(
      join(fixture.fork, "scripts/simple-changes-runtime.sh"),
      "utf8"
    );
    const skillBefore = readFileSync(join(fixture.fork, "SKILL.md"), "utf8");
    expect(applyForkPlan(plan).review).toContain(
      "scripts/simple-changes-runtime.sh"
    );
    expect(readFileSync(join(fixture.fork, "SKILL.md"), "utf8")).toBe(
      skillBefore
    );
    expect(
      readFileSync(
        join(fixture.fork, "runtime/scripts/simple-changes.ts"),
        "utf8"
      )
    ).toBe(cliSource(RELEASED_COMMANDS));
    expect(
      readFileSync(
        join(fixture.fork, "scripts/simple-changes-runtime.sh"),
        "utf8"
      )
    ).toBe(gateBefore);
    // A review entry is never written, so the gate keeps its own contents.
    expect(
      readFileSync(
        join(fixture.fork, "scripts/simple-changes-runtime.sh"),
        "utf8"
      )
    ).toContain("exit 64");
    expect(plan.pinUpdate.to).toBeNull();
    expect(plan.pinUpdate.reason).toContain("gate review");
    const repeated = planForkUpdate({
      fork: fixture.fork,
      source: fixture.source,
      upstream: fixture.upstream,
    });
    expect(repeated.pinUpdate.from).toBe(fixture.pin);
    expect(repeated.pinUpdate.to).toBeNull();
    expect(
      repeated.entries.find(
        (entry) => entry.forkPath === "scripts/simple-changes-runtime.sh"
      )?.action
    ).toBe("review");

    const gatePath = join(fixture.fork, "scripts/simple-changes-runtime.sh");
    writeFileSync(
      gatePath,
      readFileSync(gatePath, "utf8").replace(
        "loop | worktree)",
        "loop | worktree | prune)"
      )
    );
    const resolved = planForkUpdate({
      fork: fixture.fork,
      source: fixture.source,
      upstream: fixture.upstream,
    });
    expect(resolved.pinUpdate.to).toBe(fixture.release);
    expect(
      resolved.entries.find(
        (entry) => entry.forkPath === "scripts/simple-changes-runtime.sh"
      )?.action
    ).toBe("keep-fork-only");
    applyForkPlan(resolved);
    expect(
      planForkUpdate({
        fork: fixture.fork,
        source: fixture.source,
        upstream: fixture.upstream,
      }).pinUpdate.from
    ).toBe(fixture.release);
  });

  test("does not mistake scattered command prose for a command gate", () => {
    const fixture = createFixture();
    // An eval suite names as many commands as an allowlist does, one per case.
    // Density, not the total, is what separates it from a gate.
    write(
      fixture.fork,
      "evals/evals.json",
      JSON.stringify(
        {
          cases: PINNED_COMMANDS.map((command) => ({
            expected: [`Holds the lease for the whole ${command} run.`],
            prompt: `Walk an agent through ${command} without inferring authority it was never granted.`,
          })),
        },
        null,
        2
      )
    );

    const plan = planForkUpdate({
      fork: fixture.fork,
      source: fixture.source,
      upstream: fixture.upstream,
    });
    const byPath = Object.fromEntries(
      plan.entries.map((entry) => [entry.forkPath, entry.action])
    );

    expect(byPath["evals/evals.json"]).toBe("keep-fork-only");
    // The stock wrapper execs the runtime without enumerating any command, so
    // it gates nothing and the new upstream command is not its problem.
    expect(byPath["scripts/simple-changes-runtime.sh"]).toBe("keep-fork-only");
    expect(byPath["notes.md"]).toBe("keep-fork-only");
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
    expect(settled.pinUpdate.to).toBe(fixture.release);
    expect(settled.pinUpdate.reason).not.toContain("conflicts");
    expect(applyForkPlan(settled)).toMatchObject({
      pin: { from: fixture.release, to: fixture.release },
      written: [],
    });
  });

  test("holds the pin on a changed or new upstream reference the fork neither carries nor records", () => {
    const fixture = createFixture();
    rmSync(join(fixture.fork, "references/fork-maintenance.md"));
    // Without the SPEC.md conflict, the omissions alone block the update.
    write(fixture.fork, "SPEC.md", "# Spec\n\n- guarantee a\n- guarantee b\n");
    const plan = planForkUpdate({
      fork: fixture.fork,
      source: fixture.source,
      upstream: fixture.upstream,
    });
    const entry = (path: string) =>
      plan.entries.find((candidate) => candidate.forkPath === path);

    expect(entry("references/deployments.md")).toMatchObject({
      action: "unrecorded-omission",
    });
    expect(entry("references/deployments.md")?.reason).toStartWith(
      "Changed upstream, and the fork neither carries this reference"
    );
    expect(entry("references/signatures.md")?.reason).toStartWith(
      "New upstream, and the fork neither carries this reference"
    );
    expect(plan.summary["unrecorded-omission"]).toBe(2);
    expect(plan.summary.conflict).toBe(0);
    expect(plan.pinUpdate.to).toBeNull();
    expect(plan.pinUpdate.reason).toContain(
      "neither carries nor lists under Intentional omissions in references/fork-maintenance.md"
    );
    expect(entry("SKILL.md")).toMatchObject({ action: "review" });
    expect(entry("SKILL.md")?.reason).toContain(
      "every unrecorded reference omission"
    );
    // Runtime updates still apply while the pin waits.
    expect(entry("runtime/scripts/lib/core.ts")?.action).toBe("update");

    const planPath = join(fixture.base, "plan.json");
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
    writeFileSync(planPath, decoder.decode(planned.stdout));
    const skillBefore = readFileSync(join(fixture.fork, "SKILL.md"), "utf8");
    const applied = spawnSync(
      [process.execPath, cliPath, "apply", "--plan", planPath, "--json"],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(applied.exitCode).toBe(3);
    expect(JSON.parse(decoder.decode(applied.stdout))).toMatchObject({
      pin: { from: fixture.pin, to: null },
      unrecordedOmissions: [
        "references/deployments.md",
        "references/signatures.md",
      ],
    });
    expect(readFileSync(join(fixture.fork, "SKILL.md"), "utf8")).toBe(
      skillBefore
    );
    expect(existsSync(join(fixture.fork, "references/signatures.md"))).toBe(
      false
    );

    // Carry one reference and record the other: the pin advances.
    cpSync(
      join(fixture.source, "references/signatures.md"),
      join(fixture.fork, "references/signatures.md")
    );
    write(
      fixture.fork,
      "references/fork-maintenance.md",
      "## Intentional omissions\n\n- `references/deployments.md`: Acme deploys through its own pipeline.\n"
    );
    const resolved = planForkUpdate({
      fork: fixture.fork,
      source: fixture.source,
      upstream: fixture.upstream,
    });
    const settled = (path: string) =>
      resolved.entries.find((candidate) => candidate.forkPath === path);
    expect(settled("references/signatures.md")?.action).toBe("current");
    expect(settled("references/deployments.md")).toMatchObject({
      action: "review",
    });
    expect(settled("references/deployments.md")?.reason).toContain(
      "records it as an intentional omission (Acme deploys through its own pipeline.)"
    );
    expect(resolved.summary["unrecorded-omission"]).toBe(0);
    expect(resolved.pinUpdate.to).toBe(fixture.release);
    expect(applyForkPlan(resolved)).toMatchObject({
      pin: { from: fixture.pin, to: fixture.release },
      unrecordedOmissions: [],
    });
  });

  test("reads omission records only from their section, outside code", () => {
    const fixture = createFixture();
    write(
      fixture.fork,
      "references/fork-maintenance.md",
      [
        "# Acme fork maintenance",
        "",
        "- `references/sync.md`: outside the section, so not a record.",
        "",
        "## Intentional omissions",
        "",
        "Record each omitted file like this:",
        "",
        "```md",
        "- `references/example.md`: an example inside a fence.",
        "```",
        "",
        "- `references/deployments.md`: Acme deploys through its own pipeline.",
        "- `references/providers/radicle.md` with no colon is not a record.",
        "- `references/empty.md`:",
        "",
        "### Notes",
        "",
        "* `references/nested.md`: a subsection still belongs to the section.",
        "",
        "## Sync history",
        "",
        "- `references/later.md`: after the section, so not a record.",
        "",
      ].join("\n")
    );
    expect([...intentionalOmissions(fixture.fork)]).toEqual([
      ["references/deployments.md", "Acme deploys through its own pipeline."],
      ["references/nested.md", "a subsection still belongs to the section."],
    ]);
    rmSync(join(fixture.fork, "references/fork-maintenance.md"));
    expect(intentionalOmissions(fixture.fork).size).toBe(0);
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

  test("rejects hostile saved paths before writing outside the fork", () => {
    const fixture = createFixture();
    const plan = planForkUpdate({
      fork: fixture.fork,
      source: fixture.source,
      upstream: fixture.upstream,
    });
    const outside = join(fixture.base, "outside.txt");
    const hostile = structuredClone(plan);
    const [firstEntry] = hostile.entries;
    if (!firstEntry) {
      throw new Error("fixture plan unexpectedly has no entries");
    }
    firstEntry.forkPath = "../../../../outside.txt";
    firstEntry.content = "owned\n";

    expect(() => applyForkPlan(hostile)).toThrow("invalid file entry");
    expect(existsSync(outside)).toBe(false);

    const moved = structuredClone(plan);
    moved.fork.path = join(fixture.base, "Developer", "project");
    expect(() => applyForkPlan(moved)).toThrow("fork identity changed");
  });

  test("moves current literals and leaves the fork's own records as written", () => {
    const fixture = createFixture();
    const { pin, release } = fixture;
    const recordPath = join(fixture.fork, "references/fork-maintenance.md");
    const rangeHeading = `## Sync 0.0.9 to 0.1.0 (\`aaaaaaa..${pin}\`)`;
    writeFileSync(
      recordPath,
      [
        readFileSync(recordPath, "utf8"),
        "## Current pin",
        "",
        `Pinned at \`${pin}\`, bundling Simple Changes 0.1.0.`,
        "",
        "```sh",
        `# History is not a heading inside a fence: ${pin}`,
        "```",
        "",
        "## History",
        "",
        "### Upstream 0.1.0",
        "",
        `- Pinned to \`${pin}\` with Simple Changes 0.1.0.`,
        "",
        rangeHeading,
        "",
        `- Adopted the runtime from \`${pin}\`.`,
        "",
      ].join("\n")
    );
    const testScript = join(fixture.fork, "scripts/test.sh");
    writeFileSync(
      testScript,
      `${readFileSync(testScript, "utf8")}grep -Fq '${rangeHeading}' references/fork-maintenance.md\n`
    );

    const plan = planForkUpdate({
      fork: fixture.fork,
      source: fixture.source,
      upstream: fixture.upstream,
    });
    expect(
      plan.literalRewrites
        .filter(
          (rewrite) => rewrite.forkPath === "references/fork-maintenance.md"
        )
        .map((rewrite) => rewrite.to)
        .sort((left, right) => left.localeCompare(right))
    ).toEqual(
      [release, "Simple Changes 0.2.0"].sort((left, right) =>
        left.localeCompare(right)
      )
    );
    applyForkPlan(plan);

    const record = readFileSync(recordPath, "utf8");
    expect(record).toContain(
      `Pinned at \`${release}\`, bundling Simple Changes 0.2.0.`
    );
    expect(record).toContain(
      `# History is not a heading inside a fence: ${release}`
    );
    expect(record).toContain(
      `- Pinned to \`${pin}\` with Simple Changes 0.1.0.`
    );
    expect(record).toContain(rangeHeading);
    expect(record).toContain(`- Adopted the runtime from \`${pin}\`.`);
    const script = readFileSync(testScript, "utf8");
    expect(script).toContain(`grep -Fq '${rangeHeading}'`);
    expect(script).toContain(`@ \`${release}\``);
  });

  test("refuses stale literal targets and conflict sidecars", () => {
    const fixture = createFixture();
    const literalPlan = planForkUpdate({
      fork: fixture.fork,
      source: fixture.source,
      upstream: fixture.upstream,
    });
    writeFileSync(join(fixture.fork, "notes.md"), "concurrent edit\n");
    expect(() => applyForkPlan(literalPlan)).toThrow(
      "notes.md changed after the plan was made"
    );

    const fresh = createFixture();
    const conflictPlan = planForkUpdate({
      fork: fresh.fork,
      source: fresh.source,
      upstream: fresh.upstream,
    });
    const sidecar = join(fresh.fork, "SPEC.md.upstream-merge");
    writeFileSync(sidecar, "existing review\n");
    expect(() => applyForkPlan(conflictPlan)).toThrow(
      "SPEC.md.upstream-merge changed after the plan was made"
    );
    expect(readFileSync(sidecar, "utf8")).toBe("existing review\n");
  });

  test("rejects symlink escapes during planning and again before apply", () => {
    const fixture = createFixture();
    const outside = join(fixture.base, "outside-core.ts");
    writeFileSync(outside, "export const core = 1;\n");
    const core = join(fixture.fork, "runtime/scripts/lib/core.ts");
    rmSync(core);
    symlinkSync(outside, core);
    expect(() =>
      planForkUpdate({
        fork: fixture.fork,
        source: fixture.source,
        upstream: fixture.upstream,
      })
    ).toThrow("traverses a symlink inside the fork");
    expect(readFileSync(outside, "utf8")).toBe("export const core = 1;\n");

    const fresh = createFixture();
    const plan = planForkUpdate({
      fork: fresh.fork,
      source: fresh.source,
      upstream: fresh.upstream,
    });
    const outsideNotes = join(fresh.base, "outside-notes.md");
    writeFileSync(outsideNotes, "Bundled Simple Changes 0.1.0.\n");
    rmSync(join(fresh.fork, "notes.md"));
    symlinkSync(outsideNotes, join(fresh.fork, "notes.md"));
    expect(() => applyForkPlan(plan)).toThrow(
      "traverses a symlink inside the fork"
    );
    expect(readFileSync(outsideNotes, "utf8")).toBe(
      "Bundled Simple Changes 0.1.0.\n"
    );
  });

  test("refuses a conflict sidecar after the live file drifts", () => {
    const fixture = createFixture();
    const plan = planForkUpdate({
      fork: fixture.fork,
      source: fixture.source,
      upstream: fixture.upstream,
    });
    writeFileSync(join(fixture.fork, "SPEC.md"), "concurrent conflict edit\n");
    expect(() => applyForkPlan(plan)).toThrow(
      "SPEC.md changed after the plan was made"
    );
    expect(existsSync(join(fixture.fork, "SPEC.md.upstream-merge"))).toBe(
      false
    );
  });

  test("keeps the provenance pin pending when SKILL.md conflicts", () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.fork, "SKILL.md"),
      `---\nname: acme-simple-changes\n---\n\n# Acme Simple Changes\n\nForked from \`simple-changes\` @ \`${fixture.pin}\`. Acme-specific deltas: GitLab only.\n\nFork intro.\n\n## Rules\n\nRule one.\n`
    );
    writeFileSync(
      join(fixture.upstream, "skills/simple-changes/SKILL.md"),
      "---\nname: simple-changes\n---\n\n# Simple Changes\n\nUpstream intro.\n\n## Rules\n\nRule one.\n"
    );
    git(fixture.upstream, ["add", "."]);
    git(fixture.upstream, ["commit", "-q", "-m", "conflicting release"]);
    cpSync(join(fixture.upstream, "skills/simple-changes"), fixture.source, {
      force: true,
      recursive: true,
    });

    const plan = planForkUpdate({
      fork: fixture.fork,
      source: fixture.source,
      upstream: fixture.upstream,
    });
    expect(
      plan.entries.find((entry) => entry.forkPath === "SKILL.md")?.action
    ).toBe("conflict");
    expect(plan.pinUpdate.to).toBeNull();
    expect(
      plan.literalRewrites.some((rewrite) => rewrite.from === fixture.pin)
    ).toBe(false);

    const receipt = applyForkPlan(plan);
    expect(receipt.pin).toEqual({ from: fixture.pin, to: null });
    expect(readFileSync(join(fixture.fork, "SKILL.md"), "utf8")).toContain(
      fixture.pin
    );
    expect(existsSync(join(fixture.fork, "SKILL.md.upstream-merge"))).toBe(
      true
    );
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
      "Several forks at once",
      "Assign one agent per repository",
      "start agents only after approval",
      "work through the forks one at a time",
      "the step 7 handoff (queue, integrate, or ship) proposed for each",
      "`unrecorded-omission`",
      "`## Intentional",
    ]) {
      expect(skill).toContain(required);
    }
    for (const action of [
      "keep-fork-delta",
      "conflict",
      "review",
      "keep-fork-only",
      "skip",
      "unrecorded-omission",
    ]) {
      expect(reference).toContain(action);
    }
    expect(reference).toContain("--skill update-local-forks");
  });
});
