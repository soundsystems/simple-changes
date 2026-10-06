#!/usr/bin/env bun

import {
  afterEach,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
// biome-ignore lint/performance/noNamespaceImport: mock.module must stand in for every node:fs export.
import * as fs from "node:fs";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  type ForkPlan,
  inspectFork,
  intentionalOmissions,
  openUpstream,
  planForkUpdate,
  releaseWindow,
  rewriteLiteral,
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

const changelogThrough = (...versions: string[]): string =>
  [
    "# Changelog",
    "",
    ...versions.flatMap((version) => [
      `## ${version} - 2026-01-01`,
      "",
      "- notes",
      "",
    ]),
  ].join("\n");

/** Commit packaged-skill files on the upstream's current branch. */
const commitPackage = (
  upstream: string,
  message: string,
  files: Record<string, string>
): string => {
  for (const [path, contents] of Object.entries(files)) {
    write(upstream, `skills/simple-changes/${path}`, contents);
  }
  git(upstream, ["add", "-A"]);
  git(upstream, ["commit", "-q", "-m", message]);
  return git(upstream, ["rev-parse", "HEAD"]);
};

/** Install the upstream's current packaged tree as a separate source. */
const installSnapshot = (fixture: Fixture, name: string): string => {
  const destination = join(fixture.base, "installs", name, "simple-changes");
  cpSync(join(fixture.upstream, "skills/simple-changes"), destination, {
    recursive: true,
  });
  return destination;
};

/**
 * Run `body` while `directory` also lists one file named by raw `name` bytes,
 * as a filesystem that keeps any name would; APFS refuses names that are not
 * valid UTF-8, so `node:fs` is mocked. Byte listings return the raw name, text
 * listings decode it as Node does, and the raw path reads `contents`.
 */
const withRawName = <T>(
  directory: string,
  name: Buffer,
  contents: string,
  body: () => T
): T => {
  const real = {
    lstatSync: fs.lstatSync,
    readdirSync: fs.readdirSync,
    readFileSync: fs.readFileSync,
    statSync: fs.statSync,
  };
  // Kept outside every tree a plan walks.
  const store = mkdtempSync(join(tmpdir(), "update-local-forks-raw-name-"));
  const backing = join(store, "contents");
  writeFileSync(backing, contents);
  const rawPath = Buffer.concat([Buffer.from(`${directory}/`), name]);
  const resolveRaw = (path: unknown): unknown =>
    path instanceof Uint8Array && Buffer.from(path).equals(rawPath)
      ? backing
      : path;
  const listsDirectory = (path: unknown): boolean =>
    (path instanceof Uint8Array
      ? Buffer.from(path).toString()
      : String(path)) === directory;
  const redirect =
    (original: (...args: never[]) => unknown) =>
    (path: unknown, ...rest: unknown[]): unknown =>
      (original as (...args: unknown[]) => unknown)(resolveRaw(path), ...rest);
  const listDirectory = (path: unknown, options?: unknown): unknown[] => {
    const entries = (real.readdirSync as (...args: unknown[]) => unknown[])(
      path,
      options
    );
    if (!listsDirectory(path)) {
      return entries;
    }
    const { encoding, withFileTypes } = (options ?? {}) as {
      encoding?: string;
      withFileTypes?: boolean;
    };
    const decoded = new TextDecoder().decode(name);
    if (encoding === "buffer") {
      return [...entries, name];
    }
    return [
      ...entries,
      withFileTypes
        ? {
            isDirectory: () => false,
            isFile: () => true,
            isSymbolicLink: () => false,
            name: decoded,
            parentPath: directory,
          }
        : decoded,
    ];
  };
  mock.module("node:fs", () => ({
    ...fs,
    lstatSync: redirect(real.lstatSync),
    readdirSync: listDirectory,
    readFileSync: redirect(real.readFileSync),
    statSync: redirect(real.statSync),
  }));
  try {
    return body();
  } finally {
    mock.module("node:fs", () => ({ ...fs, ...real }));
    rmSync(store, { force: true, recursive: true });
  }
};

/**
 * The 0.25.0 shape: release 0.3.0 is prepared on a side branch, review fixes
 * land after the release-prep commit without touching the changelog, main
 * moves on outside the package, and a merge brings the fixed tree onto main.
 */
const releaseThroughSideBranch = (fixture: Fixture) => {
  const { upstream } = fixture;
  git(upstream, ["checkout", "-q", "-b", "release-0.3.0"]);
  const entry = commitPackage(
    upstream,
    "chore(release): Prepare Simple Changes 0.3.0",
    {
      "CHANGELOG.md": changelogThrough("0.3.0", "0.2.0", "0.1.0"),
      "scripts/lib/core.ts": "export const core = 3;\n",
    }
  );
  const entrySource = installSnapshot(fixture, "entry");
  commitPackage(upstream, "fix(core): Address the first review", {
    "scripts/lib/core.ts": "export const core = 31;\n",
  });
  const sideTip = commitPackage(
    upstream,
    "fix(core): Address the second review",
    {
      "scripts/lib/core.ts": "export const core = 32;\n",
    }
  );
  git(upstream, ["checkout", "-q", "main"]);
  write(upstream, "README.md", "# Upstream\n");
  git(upstream, ["add", "-A"]);
  git(upstream, ["commit", "-q", "-m", "docs: Add a readme"]);
  git(upstream, [
    "merge",
    "-q",
    "--no-ff",
    "-m",
    "Merge branch 'release-0.3.0' into 'main'",
    "release-0.3.0",
  ]);
  const merge = git(upstream, ["rev-parse", "HEAD"]);
  return {
    entry,
    entrySource,
    merge,
    released: installSnapshot(fixture, "released"),
    sideTip,
  };
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

  test("pins the merge that brought review fixes after the release entry onto main", () => {
    const fixture = createFixture();
    const { entry, entrySource, merge, released, sideTip } =
      releaseThroughSideBranch(fixture);
    // The side-branch tip and the merge carry the same packaged tree; only
    // the merge is on main's first-parent history.
    expect(
      git(fixture.upstream, ["rev-parse", `${sideTip}:skills/simple-changes`])
    ).toBe(
      git(fixture.upstream, ["rev-parse", `${merge}:skills/simple-changes`])
    );

    const plan = planForkUpdate({
      fork: fixture.fork,
      source: released,
      upstream: fixture.upstream,
    });
    expect(plan.source).toMatchObject({
      commit: merge,
      commitVerified: true,
      version: "0.3.0",
    });
    expect(plan.pinUpdate).toMatchObject({ from: fixture.pin, to: merge });
    expect(plan.pinUpdate.reason).toBe(
      `byte-identical tree at ${merge.slice(0, 12)}, after the 0.3.0 release entry ${entry.slice(0, 12)} on main`
    );
    expect(plan.literalRewrites.some((rewrite) => rewrite.to === merge)).toBe(
      true
    );

    // A tree that only the side branch carries still pins, to that commit,
    // which main reaches through the merge.
    const atEntry = planForkUpdate({
      fork: fixture.fork,
      source: entrySource,
      upstream: fixture.upstream,
    });
    expect(atEntry.source).toMatchObject({
      commit: entry,
      commitVerified: true,
    });
    expect(atEntry.pinUpdate.to).toBe(entry);
    expect(atEntry.pinUpdate.reason).toContain(
      "on a branch merged into main; no first-parent commit of main carries that tree"
    );

    expect(applyForkPlan(plan).pin).toEqual({ from: fixture.pin, to: merge });
    expect(readFileSync(join(fixture.fork, "SKILL.md"), "utf8")).toContain(
      `Forked from \`simple-changes\` @ \`${merge}\``
    );
  });

  test("keeps pinning the release entry itself when the installed source matches it", () => {
    const fixture = createFixture();
    const entry = commitPackage(
      fixture.upstream,
      "chore(release): Prepare Simple Changes 0.3.0",
      {
        "CHANGELOG.md": changelogThrough("0.3.0", "0.2.0", "0.1.0"),
        "scripts/lib/core.ts": "export const core = 3;\n",
      }
    );
    const atEntry = installSnapshot(fixture, "entry");
    commitPackage(fixture.upstream, "fix(core): Address review", {
      "scripts/lib/core.ts": "export const core = 31;\n",
    });

    const plan = planForkUpdate({
      fork: fixture.fork,
      source: atEntry,
      upstream: fixture.upstream,
    });
    expect(plan.source).toMatchObject({
      commit: entry,
      commitVerified: true,
      version: "0.3.0",
    });
    expect(plan.pinUpdate).toEqual({
      from: fixture.pin,
      reason: "byte-identical tree",
      to: entry,
    });
  });

  test("never bumps the pin when no commit after the release entry matches", () => {
    const fixture = createFixture();
    const { entry, merge, released } = releaseThroughSideBranch(fixture);
    writeFileSync(
      join(released, "scripts/lib/core.ts"),
      "export const core = 99;\n"
    );

    const plan = planForkUpdate({
      fork: fixture.fork,
      source: released,
      upstream: fixture.upstream,
    });
    expect(plan.source).toMatchObject({
      commit: entry,
      commitVerified: false,
      version: "0.3.0",
    });
    expect(plan.pinUpdate.to).toBeNull();
    // The entry, both review fixes, and the merge; main's own readme commit
    // does not descend from the entry.
    expect(plan.pinUpdate.reason).toBe(
      "The installed source is not byte-identical to any of the 4 commit(s) on main from the 0.3.0 release entry up to the next release entry; the pin will not be bumped."
    );
    expect(
      plan.literalRewrites.some(
        (rewrite) => rewrite.to === merge || rewrite.to === entry
      )
    ).toBe(false);
  });

  test("stops reading commits at the next release entry", () => {
    const fixture = createFixture();
    const { upstream } = fixture;
    const entry = commitPackage(
      upstream,
      "chore(release): Prepare Simple Changes 0.3.0",
      {
        "CHANGELOG.md": changelogThrough("0.3.0", "0.2.0", "0.1.0"),
        "scripts/lib/core.ts": "export const core = 3;\n",
      }
    );
    const fix = commitPackage(upstream, "fix(core): Address review", {
      "scripts/lib/core.ts": "export const core = 31;\n",
    });
    commitPackage(upstream, "chore(release): Prepare Simple Changes 0.4.0", {
      "CHANGELOG.md": changelogThrough("0.4.0", "0.3.0", "0.2.0", "0.1.0"),
    });
    for (let index = 0; index < 20; index += 1) {
      commitPackage(upstream, `fix(core): Follow up ${index}`, {
        "scripts/lib/core.ts": `export const core = ${40 + index};\n`,
      });
    }
    const handle = openUpstream({ upstream });

    const bounded = releaseWindow(handle, entry, "main", "0.3.0");
    expect(bounded.commits).toEqual([entry, fix]);
    // The entry, the fix, and the 0.4.0 entry that bounds them; none of the
    // twenty commits after it is read.
    expect(bounded.examined).toBe(3);

    // A branch cut from the window and merged after the next release entry
    // still joins it: the walk stays open while any child is undecided.
    git(upstream, ["checkout", "-q", "-b", "late", fix]);
    const late = commitPackage(upstream, "fix(core): Land a late fix", {
      "scripts/lib/late.ts": "export const late = true;\n",
    });
    git(upstream, ["checkout", "-q", "main"]);
    git(upstream, ["merge", "-q", "--no-ff", "-m", "Merge late", "late"]);
    const open = releaseWindow(handle, entry, "main", "0.3.0");
    expect([...open.commits].sort()).toEqual([entry, fix, late].sort());
  });

  test("proves byte identity on raw bytes, never decoded text", () => {
    const fixture = createFixture();
    const { upstream } = fixture;
    const path = "scripts/lib/bytes.txt";
    // A truncated four-byte sequence is invalid UTF-8 that decodes to one
    // replacement character, whose own encoding is just as long: the two
    // files have the same size and decode alike, but differ byte for byte.
    const released = Buffer.from([0x61, 0xf0, 0x9f, 0x92, 0x0a]);
    const lookalike = Buffer.from([0x61, 0xef, 0xbf, 0xbd, 0x0a]);
    expect(new TextDecoder().decode(released)).toBe(
      new TextDecoder().decode(lookalike)
    );
    writeFileSync(join(upstream, "skills/simple-changes", path), released);
    git(upstream, ["add", "-A"]);
    git(upstream, ["commit", "-q", "-m", "fix(core): Ship a byte fixture"]);
    const fix = git(upstream, ["rev-parse", "HEAD"]);
    const exact = installSnapshot(fixture, "exact");
    const lookalikeSource = installSnapshot(fixture, "lookalike");
    writeFileSync(join(lookalikeSource, path), lookalike);

    const plan = planForkUpdate({
      fork: fixture.fork,
      source: lookalikeSource,
      upstream,
    });
    expect(plan.source).toMatchObject({
      commit: fixture.release,
      commitVerified: false,
    });
    expect(plan.pinUpdate.to).toBeNull();
    // The release's own bytes, invalid UTF-8 included, still prove it.
    expect(
      planForkUpdate({ fork: fixture.fork, source: exact, upstream }).source
    ).toMatchObject({ commit: fix, commitVerified: true });
  });

  test("applies invalid UTF-8 byte for byte and moves only the literal", () => {
    const fixture = createFixture();
    const { upstream } = fixture;
    const skill = join(upstream, "skills/simple-changes");
    const truncated = Buffer.from([0xf0, 0x9f, 0x92]);
    const bytes = (...parts: (string | Buffer)[]): Buffer =>
      Buffer.concat(
        parts.map((part) =>
          typeof part === "string" ? Buffer.from(part) : part
        )
      );
    // A new runtime file (add), a runtime file the fork left alone (update),
    // and a SKILL.md line the fork's own edits surround (merge).
    const added = bytes("a", truncated, "\n");
    const updated = bytes("export const core = 3; // ", truncated, "\n");
    writeFileSync(join(skill, "scripts/lib/bytes.txt"), added);
    writeFileSync(join(skill, "scripts/lib/core.ts"), updated);
    const [before, after] = readFileSync(join(skill, "SKILL.md"), "utf8").split(
      "Intro line, revised."
    );
    const revised = bytes("Intro line, revised ", truncated, ".");
    writeFileSync(
      join(skill, "SKILL.md"),
      bytes(before ?? "", revised, after ?? "")
    );
    git(upstream, ["add", "-A"]);
    git(upstream, ["commit", "-q", "-m", "fix(core): Ship raw bytes"]);
    const shipped = git(upstream, ["rev-parse", "HEAD"]);
    const source = installSnapshot(fixture, "shipped");
    // A fork-owned note that names the old release beside invalid UTF-8.
    writeFileSync(
      join(fixture.fork, "notes.md"),
      bytes("Bundled Simple Changes 0.1.0 ", truncated, ".\n")
    );

    const plan = planForkUpdate({ fork: fixture.fork, source, upstream });
    expect(plan.pinUpdate.to).toBe(shipped);
    // Apply a saved plan, as the CLI does.
    applyForkPlan(JSON.parse(JSON.stringify(plan)));

    const forkFile = (path: string): Buffer =>
      readFileSync(join(fixture.fork, path));
    expect(forkFile("runtime/scripts/lib/bytes.txt").toString("hex")).toBe(
      added.toString("hex")
    );
    expect(forkFile("runtime/scripts/lib/core.ts").toString("hex")).toBe(
      updated.toString("hex")
    );
    const forkSkill = forkFile("SKILL.md");
    expect(forkSkill.includes(revised)).toBe(true);
    expect(forkSkill.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
    expect(forkSkill.toString("latin1")).toContain(
      `Forked from \`simple-changes\` @ \`${shipped}\``
    );
    expect(forkSkill.toString("latin1")).toContain("## Acme rules");
    expect(forkFile("notes.md").toString("hex")).toBe(
      bytes("Bundled Simple Changes 0.2.0 ", truncated, ".\n").toString("hex")
    );
    // The saved plan carries those bytes as base64, never as decoded text.
    const entry = (path: string) =>
      plan.entries.find((candidate) => candidate.forkPath === path);
    expect(entry("runtime/scripts/lib/bytes.txt")).toMatchObject({
      action: "add",
      contentBase64: added.toString("base64"),
    });
    expect(entry("runtime/scripts/lib/core.ts")).toMatchObject({
      action: "update",
      contentBase64: updated.toString("base64"),
    });
    expect(entry("SKILL.md")?.action).toBe("merge");
    expect(entry("SKILL.md")?.content).toBeUndefined();
  });

  test("never verifies a release tree that names a path that is not valid UTF-8", () => {
    const fixture = createFixture();
    const { upstream } = fixture;
    const skill = "skills/simple-changes";
    // A valid non-ASCII name verifies exactly as before.
    write(upstream, `${skill}/scripts/lib/café.txt`, "same\n");
    git(upstream, ["add", "-A"]);
    git(upstream, ["commit", "-q", "-m", "fix(core): Ship a named fixture"]);
    const named = git(upstream, ["rev-parse", "HEAD"]);
    const exact = installSnapshot(fixture, "exact");
    // The same name spelled with a combining accent is a different path.
    const decomposed = installSnapshot(fixture, "decomposed");
    rmSync(join(decomposed, "scripts/lib/café.txt"));
    writeFileSync(join(decomposed, "scripts/lib/cafe\u0301.txt"), "same\n");
    expect(
      readdirSync(join(decomposed, "scripts/lib"), { encoding: "buffer" }).map(
        (raw) => Buffer.from(raw).toString("hex")
      )
    ).toContain(Buffer.from("cafe\u0301.txt").toString("hex"));
    // Git keeps any filename bytes. F0 9F 92 is a truncated sequence that
    // decodes to the replacement character, whose own encoding EF BF BD
    // names a different file; macOS cannot create the first, so it goes
    // straight into the index.
    const truncated = Buffer.from([0xf0, 0x9f, 0x92]);
    const blob = git(upstream, [
      "hash-object",
      "-w",
      join(upstream, skill, "scripts/lib/café.txt"),
    ]);
    const indexed = spawnSync(
      ["git", "-C", upstream, "update-index", "--add", "-z", "--index-info"],
      {
        stderr: "pipe",
        stdin: Buffer.concat([
          Buffer.from(`100644 ${blob}\t${skill}/scripts/lib/`),
          truncated,
          Buffer.from(".txt\0"),
        ]),
        stdout: "pipe",
      }
    );
    expect(indexed.exitCode).toBe(0);
    git(upstream, [
      "commit",
      "-q",
      "-m",
      "fix(core): Ship a raw-named fixture",
    ]);
    const rawNamed = git(upstream, ["rev-parse", "HEAD"]);
    const lookalike = installSnapshot(fixture, "lookalike");
    writeFileSync(
      join(lookalike, `scripts/lib/${new TextDecoder().decode(truncated)}.txt`),
      "same\n"
    );
    const hex = Buffer.concat([
      Buffer.from("scripts/lib/"),
      truncated,
      Buffer.from(".txt"),
    ]).toString("hex");

    const plan = planForkUpdate({
      fork: fixture.fork,
      source: lookalike,
      upstream,
    });
    expect(plan.source).toMatchObject({
      commit: fixture.release,
      commitVerified: false,
    });
    expect(plan.pinUpdate.to).toBeNull();
    expect(plan.pinUpdate.reason).toContain(
      `A path that is not valid UTF-8 is never verified, and ${rawNamed.slice(0, 12)} names path bytes ${hex}.`
    );
    expect(
      planForkUpdate({ fork: fixture.fork, source: decomposed, upstream })
        .source.commitVerified
    ).toBe(false);
    expect(
      planForkUpdate({ fork: fixture.fork, source: exact, upstream }).source
    ).toMatchObject({ commit: named, commitVerified: true });
  });

  test("refuses to plan a source or fork that holds a path that is not valid UTF-8", () => {
    const fixture = createFixture();
    const { upstream } = fixture;
    const name = Buffer.concat([
      Buffer.from([0xf0, 0x9f, 0x92]),
      Buffer.from(".txt"),
    ]);
    const hex = Buffer.concat([Buffer.from("scripts/"), name]).toString("hex");
    // The release ships scripts/<F0 9F 92>.txt, straight into the index.
    const contents = join(fixture.base, "contents.txt");
    writeFileSync(contents, "same\n");
    const blob = git(upstream, ["hash-object", "-w", contents]);
    const indexed = spawnSync(
      ["git", "-C", upstream, "update-index", "--add", "-z", "--index-info"],
      {
        stderr: "pipe",
        stdin: Buffer.concat([
          Buffer.from(`100644 ${blob}\tskills/simple-changes/scripts/`),
          name,
          Buffer.from("\0"),
        ]),
        stdout: "pipe",
      }
    );
    expect(indexed.exitCode).toBe(0);
    git(upstream, ["commit", "-q", "-m", "fix(core): Ship a raw-named file"]);
    // An exact install of that release, on a filesystem that keeps the name.
    const exact = installSnapshot(fixture, "exact");
    const skillBefore = readFileSync(join(fixture.fork, "SKILL.md"), "utf8");

    withRawName(join(exact, "scripts"), name, "same\n", () => {
      expect(() =>
        planForkUpdate({ fork: fixture.fork, source: exact, upstream })
      ).toThrow(
        `The installed source at ${realpathSync(exact)} holds path bytes that are not valid UTF-8 (hex ${hex}); planning cannot carry such a file, so it refuses.`
      );
    });
    withRawName(join(fixture.fork, "scripts"), name, "fork\n", () => {
      expect(() =>
        planForkUpdate({
          fork: fixture.fork,
          source: fixture.source,
          upstream,
        })
      ).toThrow(
        `The fork at ${realpathSync(fixture.fork)} holds path bytes that are not valid UTF-8 (hex ${hex})`
      );
    });
    // No plan, so no pin moved and nothing was written or left out silently.
    expect(readFileSync(join(fixture.fork, "SKILL.md"), "utf8")).toBe(
      skillBefore
    );
    expect(
      planForkUpdate({ fork: fixture.fork, source: fixture.source, upstream })
        .pinUpdate.to
    ).toBe(fixture.release);
  });

  test("bounds the search at the next release entry", () => {
    const fixture = createFixture();
    const { upstream } = fixture;
    const entry = commitPackage(
      upstream,
      "chore(release): Prepare Simple Changes 0.3.0",
      {
        "CHANGELOG.md": changelogThrough("0.3.0", "0.2.0", "0.1.0"),
        "scripts/lib/core.ts": "export const core = 3;\n",
      }
    );
    const fix = commitPackage(upstream, "fix(core): Address review", {
      "scripts/lib/core.ts": "export const core = 31;\n",
    });
    const fixed = installSnapshot(fixture, "fixed");
    commitPackage(upstream, "chore(release): Prepare Simple Changes 0.4.0", {
      "CHANGELOG.md": changelogThrough("0.4.0", "0.3.0", "0.2.0", "0.1.0"),
      "scripts/lib/core.ts": "export const core = 4;\n",
    });
    // Backing out the 0.4.0 entry restores the 0.3.0 changelog but keeps
    // 0.4.0 work: a tree no 0.3.0 release ever shipped.
    const backedOut = commitPackage(
      upstream,
      "revert: Back out the 0.4.0 entry",
      { "CHANGELOG.md": changelogThrough("0.3.0", "0.2.0", "0.1.0") }
    );
    const hybrid = installSnapshot(fixture, "hybrid");

    const beforeNext = planForkUpdate({
      fork: fixture.fork,
      source: fixed,
      upstream,
    });
    expect(beforeNext.source).toMatchObject({
      commit: fix,
      commitVerified: true,
    });
    expect(beforeNext.pinUpdate.reason).toContain(
      `after the 0.3.0 release entry ${entry.slice(0, 12)} on main`
    );

    const pastNext = planForkUpdate({
      fork: fixture.fork,
      source: hybrid,
      upstream,
    });
    expect(pastNext.source).toMatchObject({
      commit: entry,
      commitVerified: false,
      version: "0.3.0",
    });
    expect(pastNext.source.commit).not.toBe(backedOut);
    expect(pastNext.pinUpdate.to).toBeNull();
    expect(pastNext.pinUpdate.reason).toContain(
      "any of the 2 commit(s) on main from the 0.3.0 release entry up to the next release entry"
    );
  });

  test("applies an earlier plan's text digests to valid UTF-8 and refuses them otherwise", () => {
    // Earlier releases hashed each fork file's decoded text, not its bytes.
    const textDigest = (path: string): string =>
      createHash("sha256").update(readFileSync(path, "utf8")).digest("hex");
    const savedEarlier = (fork: string, plan: ForkPlan): ForkPlan => {
      const saved = structuredClone(plan);
      for (const entry of saved.entries) {
        if (entry.forkDigest !== null) {
          entry.forkDigest = textDigest(join(fork, entry.forkPath));
        }
      }
      for (const rewrite of saved.literalRewrites) {
        rewrite.forkDigest = textDigest(join(fork, rewrite.forkPath));
      }
      return saved;
    };

    // Every file valid UTF-8: the earlier digests are the same, so it applies.
    const valid = createFixture();
    const validPlan = planForkUpdate({
      fork: valid.fork,
      source: valid.source,
      upstream: valid.upstream,
    });
    const earlier = savedEarlier(valid.fork, validPlan);
    expect(earlier).toEqual(validPlan);
    expect(applyForkPlan(earlier).pin).toEqual({
      from: valid.pin,
      to: valid.release,
    });

    // A fork note that is not valid UTF-8: the text digest no longer matches
    // its bytes, so apply refuses the plan as stale instead of writing.
    const invalid = createFixture();
    const notePath = join(invalid.fork, "notes.md");
    const note = Buffer.concat([
      Buffer.from("Bundled Simple Changes 0.1.0 "),
      Buffer.from([0xf0, 0x9f, 0x92]),
      Buffer.from(".\n"),
    ]);
    writeFileSync(notePath, note);
    const invalidPlan = planForkUpdate({
      fork: invalid.fork,
      source: invalid.source,
      upstream: invalid.upstream,
    });
    expect(
      invalidPlan.literalRewrites.some(
        (rewrite) => rewrite.forkPath === "notes.md"
      )
    ).toBe(true);
    expect(() =>
      applyForkPlan(savedEarlier(invalid.fork, invalidPlan))
    ).toThrow("notes.md changed after the plan was made; re-run plan.");
    expect(readFileSync(notePath).toString("hex")).toBe(note.toString("hex"));
    // Planning again gives a plan that applies.
    applyForkPlan(invalidPlan);
    expect(readFileSync(notePath).toString("hex")).toBe(
      Buffer.concat([
        Buffer.from("Bundled Simple Changes 0.2.0 "),
        Buffer.from([0xf0, 0x9f, 0x92]),
        Buffer.from(".\n"),
      ]).toString("hex")
    );
  });

  test("rejects a saved plan whose base64 content is not strict base64", () => {
    const fixture = createFixture();
    const plan = planForkUpdate({
      fork: fixture.fork,
      source: fixture.source,
      upstream: fixture.upstream,
    });
    const corePath = join(fixture.fork, "runtime/scripts/lib/core.ts");
    const coreBefore = readFileSync(corePath, "utf8");
    const withBase64 = (value: string) => {
      const edited = structuredClone(plan);
      const entry = edited.entries.find(
        (candidate) => candidate.forkPath === "runtime/scripts/lib/core.ts"
      );
      if (!entry) {
        throw new Error("fixture plan lost its core.ts update");
      }
      Reflect.deleteProperty(entry, "content");
      entry.contentBase64 = value;
      return edited;
    };
    // "A" decodes to nothing; the rest are short, misplaced, or mis-padded,
    // or encode bytes in a form Buffer would not produce.
    for (const value of [
      "A",
      "AB",
      "ABC",
      "AB=",
      "A===",
      "Zm9v=",
      "Zm9vYg",
      "Zm9vYg=",
      "QR==",
      "Zm9=",
      "=Zm9",
      "Zm 9v",
      "Zm9v\n",
    ]) {
      expect({
        thrown: (() => {
          try {
            applyForkPlan(withBase64(value));
            return "applied";
          } catch (error) {
            return (error as Error).message;
          }
        })(),
        value,
      }).toEqual({ thrown: "The plan carries an invalid file entry.", value });
    }
    expect(readFileSync(corePath, "utf8")).toBe(coreBefore);

    const exact = Buffer.from("export const core = 2;\n");
    applyForkPlan(withBase64(exact.toString("base64")));
    expect(readFileSync(corePath).toString("hex")).toBe(exact.toString("hex"));
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
    // A fork changelog is history even under an undated version heading.
    const forkChangelog =
      "# Changelog\n\n## 0.0.9\n\n- Bundled Simple Changes 0.1.0.\n";
    writeFileSync(join(fixture.fork, "CHANGELOG.md"), forkChangelog);
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
    expect(
      plan.literalRewrites.some(
        (rewrite) => rewrite.forkPath === "CHANGELOG.md"
      )
    ).toBe(false);
    applyForkPlan(plan);
    expect(readFileSync(join(fixture.fork, "CHANGELOG.md"), "utf8")).toBe(
      forkChangelog
    );

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

  test("keeps past release entries as written in every fork's history style", () => {
    const omissions = [
      "## Intentional omissions",
      "",
      "- `references/deployments.md`: Acme deploys through its own pipeline.",
      "- `references/signatures.md`: Acme proposals carry no agent signatures.",
      "",
    ];
    // Each note's `current` part states the pin and bundled release; its
    // `history` part records past updates and must survive the bump intact.
    const styles = (pin: string) => {
      const short = pin.slice(0, 7);
      return {
        // Top-level entries after an updating guide, as in Hashi's note.
        hashi: {
          current: [
            "# Fork maintenance",
            "",
            "## Updating this fork",
            "",
            `Plan against the installed Simple Changes 0.1.0 at \`${pin}\`.`,
            "",
            "## Current deltas",
            "",
            "- The wrapper bundles Simple Changes 0.1.0.",
            "",
            ...omissions,
          ],
          history: [
            `## Upstream 0.1.0 (\`7ab67a1..${short}\`)`,
            "",
            `- Re-pin to \`${pin}\`, Simple Changes 0.1.0.`,
            "",
            `## Fork fix: drop deltas upstream now covers (pin \`${short}\`)`,
            "",
            "Clears deltas that no longer earn their keep before the Simple Changes 0.1.0",
            "re-pin.",
            "",
            "## Fork sync: Simple Changes 0.0.9 candidate (`7ab67a1..628c66b`)",
            "",
            "- Staged ahead of Simple Changes 0.1.0.",
            "",
            "## Local Blacksmith CI bridge",
            "",
            "- `pnpm hashi ci guard-exec` runs the guard for Simple Changes 0.1.0's",
            "  `execGuard` hook.",
            "",
          ],
        },
        // Third-level entries under `## History`, as in Patrick's note.
        patrick: {
          current: [
            "# Fork maintenance",
            "",
            "## Current deltas",
            "",
            `- Bundles Simple Changes 0.1.0 at \`${pin}\`.`,
            "",
            ...omissions,
            "## Maintaining this fork",
            "",
            `Plan each update from \`${pin}\`; the runtime reports Simple Changes 0.1.0.`,
            "",
          ],
          history: [
            "## History",
            "",
            `### Upstream 0.1.0 (\`7ab67a1..${short}\`)`,
            "",
            `- Re-pin to release commit \`${pin}\` (Simple Changes 0.1.0).`,
            "",
            `### Patrick-only: retire the bundled canonical copy (pin \`${short}\` unchanged)`,
            "",
            "- The copy duplicated Simple Changes 0.1.0.",
            "",
          ],
        },
        // `## History` entries after a current section quoting an MR template
        // in a longer fence around an inner one, as in Pulse's note.
        pulse: {
          current: [
            "# Fork maintenance",
            "",
            `This fork bundles Simple Changes 0.1.0 at \`${pin}\`.`,
            "",
            "## Current deltas",
            "",
            "- The MR template:",
            "",
            "````md",
            "Shipped with Simple Changes 0.1.0.",
            "```sh",
            `echo pinned at ${pin}`,
            "````",
            "",
            ...omissions,
          ],
          history: [
            "## History",
            "",
            `### Upstream 0.1.0 (\`7ab67a1..${short}\`)`,
            "",
            `- Re-pin to release commit \`${pin}\` (Simple Changes 0.1.0).`,
            "",
            `### Pulse-only: use the runtime release gate (pin \`${short}\` unchanged)`,
            "",
            "- Simple Changes 0.1.0 decides releases.",
            "",
            `### Fork fix: Merge danger beneath a Pulse MR template (pin \`${short}\`)`,
            "",
            "- Appended under the Simple Changes 0.1.0 template.",
            "",
            "### Upstream 628c66b, pending 0.1.0 (`7ab67a1..628c66b`)",
            "",
            "- Pre-release of Simple Changes 0.1.0.",
            "",
          ],
        },
        // Top-level entries titled by a range, a lone pin, a release, a date,
        // or only a subject, as in Thor's note.
        thor: {
          current: [
            "# Fork maintenance",
            "",
            `Forked at \`${pin}\`; this fork bundles Simple Changes 0.1.0.`,
            "",
            "## Current deltas",
            "",
            "| Area | Delta |",
            "| --- | --- |",
            `| Runtime | Byte-identical to Simple Changes 0.1.0 at \`${pin}\`. |`,
            "",
            ...omissions,
            "History follows, newest first.",
            "",
          ],
          history: [
            `## Fork cleanup before the next re-pin (pin \`${short}\`)`,
            "",
            "- Keep the bridge until the Simple Changes 0.1.0 runtime carries it.",
            "",
            `## Upstream 0.1.0 (\`628c66b..${short}\`)`,
            "",
            `- Re-pin to release commit \`${pin}\` (Simple Changes 0.1.0).`,
            "",
            "## Local Blacksmith CI bridge",
            "",
            `- Guard hosted CI for Simple Changes 0.1.0 merges at \`${pin}\`.`,
            "",
            "## Canonical 0.0.9 (`1b7b7e7`)",
            "",
            "- Superseded by Simple Changes 0.1.0.",
            "",
            "## Local proposal resolutions (2026-01-15)",
            "",
            "- Resolved under Simple Changes 0.1.0.",
            "",
          ],
        },
      };
    };

    for (const style of ["thor", "hashi", "patrick", "pulse"] as const) {
      const fixture = createFixture();
      const { pin, release } = fixture;
      const { current, history } = styles(pin)[style];
      const notePath = join(fixture.fork, "references/fork-maintenance.md");
      writeFileSync(notePath, [...current, ...history].join("\n"));

      const plan = planForkUpdate({
        fork: fixture.fork,
        source: fixture.source,
        upstream: fixture.upstream,
      });
      expect(plan.pinUpdate.to).toBe(release);
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

      const moved = current.map((line) =>
        line
          .replaceAll(pin, release)
          .replaceAll("Simple Changes 0.1.0", "Simple Changes 0.2.0")
      );
      expect({ note: readFileSync(notePath, "utf8"), style }).toEqual({
        note: [...moved, ...history].join("\n"),
        style,
      });
    }

    // A note's first entry may name an abbreviated pin of any shape, since the
    // fixture's random pin cannot be relied on to produce each one.
    for (const sha of ["5028750", "deadbee", "50287b0"]) {
      const note = `# Fork maintenance\n\n## Current deltas\n\n## Fork cleanup (pin \`${sha}\`)\n\n- Keep it until Simple Changes 0.1.0.\n`;
      expect({
        rewritten: rewriteLiteral(
          "references/fork-maintenance.md",
          note,
          "Simple Changes 0.1.0",
          "Simple Changes 0.2.0"
        ).rewritten,
        sha,
      }).toEqual({ rewritten: 0, sha });
    }
  });

  test("reads a bare abbreviated SHA in a heading as a commit, but not a word or a number", () => {
    const rewritten = (heading: string) => ({
      heading,
      rewritten: rewriteLiteral(
        "references/fork-maintenance.md",
        `# Fork maintenance\n\n## Current deltas\n\n${heading}\n\n- Kept from Simple Changes 0.1.0.\n`,
        "Simple Changes 0.1.0",
        "Simple Changes 0.2.0"
      ).rewritten,
    });
    // History entries: the body under each heading is a record.
    for (const heading of [
      "## Fork cleanup (pin deadbee)",
      "## Fork cleanup (pin 5028750)",
      "### Patrick-only: retire the copy (pin deadbee unchanged)",
      "## Fork fix: saved break glass (pinned at 5028750)",
      "## Retire the copy (commit deadbee)",
      "## Canonical copy (deadbee)",
      "## Canonical copy (5028750, retired)",
      "## Upstream 628c66b, pending",
    ]) {
      expect(rewritten(heading)).toEqual({ heading, rewritten: 0 });
    }
    // Ordinary words and numbers name no commit; the body stays current.
    for (const heading of [
      "## Fix defaced badges",
      "## Issue 1234567 workaround",
    ]) {
      expect(rewritten(heading)).toEqual({ heading, rewritten: 1 });
    }
  });

  test("keeps rewriting current sections whose headings name a release or the pin", () => {
    const fixture = createFixture();
    const { pin, release } = fixture;
    const short = pin.slice(0, 7);
    // [line, current]: current lines move with the pin; the rest are records.
    // Headings are never rewritten, so links to them keep working.
    const lines: [string, boolean][] = [
      ["# Fork maintenance", false],
      ["", false],
      ["## Current upstream (0.1.0)", false],
      ["", false],
      [`Pinned at \`${pin}\`, bundling Simple Changes 0.1.0.`, true],
      ["", false],
      ["### Current deltas", false],
      ["", false],
      ["- The runtime is Simple Changes 0.1.0.", true],
      ["", false],
      ["### Runtime", false],
      ["", false],
      [`- Bundled from \`${pin}\`.`, true],
      ["", false],
      ["## Bundled runtime (0.1.0)", false],
      ["", false],
      ["- The wrapper runs Simple Changes 0.1.0.", true],
      ["", false],
      ["## Intentional omissions", false],
      ["", false],
      [
        "- `references/deployments.md`: Acme deploys through its own pipeline.",
        false,
      ],
      [
        "- `references/signatures.md`: Acme proposals carry no agent signatures.",
        false,
      ],
      ["", false],
      [`## Upstream 0.1.0 (\`7ab67a1..${short}\`)`, false],
      ["", false],
      [`- Re-pin to \`${pin}\` (Simple Changes 0.1.0).`, false],
      ["", false],
      ["## Local Blacksmith CI bridge", false],
      ["", false],
      ["- Guards merges for Simple Changes 0.1.0.", false],
      ["", false],
      // A current heading after the log ends it, even naming the pin.
      [`## Current pin (\`${short}\`)`, false],
      ["", false],
      [`Pinned at \`${pin}\`; Simple Changes 0.1.0 is installed.`, true],
      ["", false],
      ["## Upgrade notes", false],
      ["", false],
      ["- Run the Simple Changes 0.1.0 checks after each bump.", true],
      ["", false],
      ["## Upstream 0.0.9 (`628c66b..7ab67a1`)", false],
      ["", false],
      ["- Staged ahead of Simple Changes 0.1.0.", false],
      ["", false],
    ];
    const notePath = join(fixture.fork, "references/fork-maintenance.md");
    writeFileSync(notePath, lines.map(([line]) => line).join("\n"));

    const plan = planForkUpdate({
      fork: fixture.fork,
      source: fixture.source,
      upstream: fixture.upstream,
    });
    expect(plan.pinUpdate.to).toBe(release);
    applyForkPlan(plan);

    expect(readFileSync(notePath, "utf8").split("\n")).toEqual(
      lines.map(([line, current]) =>
        current
          ? line
              .replaceAll(pin, release)
              .replaceAll("Simple Changes 0.1.0", "Simple Changes 0.2.0")
          : line
      )
    );
  });

  test("reads a CRLF note's fences and history headings and keeps its line endings", () => {
    const fixture = createFixture();
    const { pin, release } = fixture;
    // [line, current]: current lines move with the pin; the rest are records.
    const lines: [string, boolean][] = [
      ["# Fork maintenance", false],
      ["", false],
      ["## Current deltas", false],
      ["", false],
      ["```sh", false],
      [`echo bundles Simple Changes 0.1.0 at ${pin}`, true],
      ["```", false],
      ["", false],
      ["The wrapper runs Simple Changes 0.1.0.", true],
      ["", false],
      ["## Intentional omissions", false],
      ["", false],
      [
        "- `references/deployments.md`: Acme deploys through its own pipeline.",
        false,
      ],
      [
        "- `references/signatures.md`: Acme proposals carry no agent signatures.",
        false,
      ],
      ["", false],
      // Only a closed fence above lets this heading start a history entry.
      ["## Upstream 0.1.0 (pin deadbee)", false],
      ["", false],
      [`- Re-pin to \`${pin}\` (Simple Changes 0.1.0).`, false],
      ["", false],
      ["## History", false],
      ["", false],
      ["### Upstream 0.0.9 (`628c66b..7ab67a1`)", false],
      ["", false],
      ["- Staged ahead of Simple Changes 0.1.0.", false],
    ];
    const crlf = (rows: string[]): string => `${rows.join("\r\n")}\r\n`;
    const notePath = join(fixture.fork, "references/fork-maintenance.md");
    writeFileSync(notePath, crlf(lines.map(([line]) => line)));

    const plan = planForkUpdate({
      fork: fixture.fork,
      source: fixture.source,
      upstream: fixture.upstream,
    });
    expect(plan.pinUpdate.to).toBe(release);
    applyForkPlan(plan);

    expect(readFileSync(notePath, "utf8")).toBe(
      crlf(
        lines.map(([line, current]) =>
          current
            ? line
                .replaceAll(pin, release)
                .replaceAll("Simple Changes 0.1.0", "Simple Changes 0.2.0")
            : line
        )
      )
    );
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
    // The text plan names each skipped fork-owned history file, not just a count.
    const text = spawnSync(
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
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(decoder.decode(text.stdout)).toContain(
      "  skip     CHANGELOG.md: The fork owns its own release history."
    );
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
