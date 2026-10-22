import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, which } from "bun";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(
  Number(process.env.SIMPLE_CHANGES_TEST_TIMEOUT_MS ?? "") || 60_000
);

// Proofs added in 0.33.0 read Git listings that may be legitimately empty, so
// the runner's lost-answer retry cannot cover them. These tests lose one such
// answer (exit 0, no output, as seen under heavy load) and check that each
// proof refuses rather than reading the lost answer as "nothing there".

const ENTRY_PATTERN = /^100644:blob:[0-9a-f]{40}$/u;
const decoder = new TextDecoder();
let cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.reverse()) {
    cleanup();
  }
  cleanups = [];
});

const repository = (): TestRepository => {
  const fixture = createTestRepository();
  cleanups.push(fixture.cleanup);
  return fixture;
};

const libraryPath = (name: string): string =>
  fileURLToPath(
    new URL(
      `../../../skills/simple-changes/scripts/lib/${name}`,
      import.meta.url
    )
  );

// A Git on PATH that answers truthfully, except that while token files
// remain, a call with an argument equal to FAKE_GIT_EMPTY_FLAG removes one
// token and exits 0 with no output.
const fakeGitDirectory = (): string => {
  const realGit = which("git");
  if (!realGit) {
    throw new Error("git is not on PATH");
  }
  const bin = mkdtempSync(join(tmpdir(), "simple-changes-fake-git-"));
  cleanups.push(() => rmSync(bin, { force: true, recursive: true }));
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
real='${realGit}'
if [ -n "$FAKE_GIT_EMPTY_FLAG" ] && [ -d "$FAKE_GIT_EMPTY_TOKENS" ]; then
  case " $* " in
    *" $FAKE_GIT_EMPTY_FLAG "*)
      for token in "$FAKE_GIT_EMPTY_TOKENS"/*; do
        rm "$token" 2>/dev/null && exit 0
      done
      ;;
  esac
fi
exec "$real" "$@"
`
  );
  chmodSync(join(bin, "git"), 0o755);
  return bin;
};

// Runs `body` in a child whose Git is the fake one, with `lost` answers to
// calls naming `flag` lost first, and returns what the child printed.
const runInChild = (
  body: string,
  flag: string,
  lost: number
): { remaining: number; reply: unknown } => {
  const bin = fakeGitDirectory();
  const tokens = mkdtempSync(join(tmpdir(), "simple-changes-lost-"));
  cleanups.push(() => rmSync(tokens, { force: true, recursive: true }));
  for (let index = 0; index < lost; index += 1) {
    writeFileSync(join(tokens, `token-${index}`), "");
  }
  const script = join(bin, "child.ts");
  writeFileSync(script, body);
  const result = spawnSync([process.execPath, script], {
    env: {
      ...process.env,
      FAKE_GIT_EMPTY_FLAG: flag,
      FAKE_GIT_EMPTY_TOKENS: tokens,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const stdout = decoder.decode(result.stdout);
  if (result.exitCode !== 0) {
    throw new Error(`child failed: ${decoder.decode(result.stderr)}${stdout}`);
  }
  return { remaining: readdirSync(tokens).length, reply: JSON.parse(stdout) };
};

describe("exact-byte target proof with a lost Git answer", () => {
  // The author's tip changes a.txt, and the target holds a different a.txt,
  // so the true answer is a refusal naming a.txt.
  const differingFixture = () => {
    const fixture = repository();
    const base = git(fixture.root, ["rev-parse", "HEAD"]);
    git(fixture.root, ["switch", "--quiet", "-c", "author"]);
    writeFixture(fixture.root, "a.txt", "alpha\n");
    git(fixture.root, ["add", "a.txt"]);
    git(fixture.root, ["commit", "--quiet", "-m", "Author a"]);
    const head = git(fixture.root, ["rev-parse", "HEAD"]);
    git(fixture.root, ["switch", "--quiet", "main"]);
    writeFixture(fixture.root, "a.txt", "beta\n");
    git(fixture.root, ["add", "a.txt"]);
    git(fixture.root, ["commit", "--quiet", "-m", "Target a"]);
    const target = git(fixture.root, ["rev-parse", "HEAD"]);
    return { base, head, root: fixture.root, target };
  };

  const prove = (flag: string, lost: number) => {
    const setup = differingFixture();
    return runInChild(
      `import { proveExactByteTargetContainment } from ${JSON.stringify(libraryPath("exact-byte-proof.ts"))};
console.log(JSON.stringify(proveExactByteTargetContainment(${JSON.stringify(setup.root)}, {
  sourceHead: ${JSON.stringify(setup.head)},
  targetRevision: ${JSON.stringify(setup.target)},
})));
`,
      flag,
      lost
    );
  };

  test("with every answer kept, the differing path refuses (control)", () => {
    const { remaining, reply } = prove("--reverse", 0);
    expect(remaining).toBe(0);
    expect(reply).toMatchObject({
      differingPaths: ["a.txt"],
      status: "refused",
    });
  });

  test.each([
    ["the commit listing", "--reverse", "listed no commits"],
    [
      "a commit's touched paths",
      "--no-commit-id",
      "listed no paths for commit",
    ],
    ["the tip-to-target difference", "--no-ext-diff", "but they differ"],
  ])("a lost answer for %s refuses instead of proving", (_what, flag, text) => {
    const { remaining, reply } = prove(flag, 1);
    expect(remaining).toBe(0);
    expect(reply).toMatchObject({ status: "refused" });
    const { reason } = reply as { reason: string };
    expect(reason).toContain(text);
    expect(reason).toContain("retry the command");
  });
});

describe("source worktree delta with a lost Git answer", () => {
  const delta = (lost: number) => {
    const fixture = repository();
    writeFixture(fixture.root, "a.txt", "tracked\n");
    git(fixture.root, ["add", "a.txt"]);
    git(fixture.root, ["commit", "--quiet", "-m", "Track a"]);
    const head = git(fixture.root, ["rev-parse", "HEAD"]);
    writeFixture(fixture.root, "a.txt", "edited\n");
    writeFixture(fixture.root, "extra.txt", "untracked\n");
    return runInChild(
      `import { sourceWorktreeDelta } from ${JSON.stringify(libraryPath("source-worktree-delta.ts"))};
const result = sourceWorktreeDelta(${JSON.stringify(fixture.root)}, ${JSON.stringify(head)}, () => null);
console.log(JSON.stringify("entries" in result ? { paths: [...result.entries.keys()].sort() } : result));
`,
      "--exclude-standard",
      lost
    );
  };

  test("with every answer kept, the untracked file is a change (control)", () => {
    const { remaining, reply } = delta(0);
    expect(remaining).toBe(0);
    expect(reply).toEqual({ paths: ["a.txt", "extra.txt"] });
  });

  test("a lost file listing refuses instead of hiding the untracked file", () => {
    const { remaining, reply } = delta(1);
    expect(remaining).toBe(0);
    expect(reply).toEqual({ failure: "its index cannot be read" });
  });
});

describe("target tree entry with a lost Git answer", () => {
  const entry = (path: string, lost: number) => {
    const fixture = repository();
    writeFixture(fixture.root, "a.txt", "tracked\n");
    git(fixture.root, ["add", "a.txt"]);
    git(fixture.root, ["commit", "--quiet", "-m", "Track a"]);
    const head = git(fixture.root, ["rev-parse", "HEAD"]);
    return runInChild(
      `import { targetTreeEntry } from ${JSON.stringify(libraryPath("loop-lease-shipment.ts"))};
try {
  console.log(JSON.stringify({ entry: targetTreeEntry(${JSON.stringify(fixture.root)}, ${JSON.stringify(head)}, ${JSON.stringify(path)}) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message, exitCode: error.exitCode }));
}
`,
      "ls-tree",
      lost
    );
  };

  test("with every answer kept, a present path has its entry and an absent one none (control)", () => {
    const present = entry("a.txt", 0);
    expect(present.remaining).toBe(0);
    expect((present.reply as { entry: string }).entry).toMatch(ENTRY_PATTERN);
    expect(entry("missing.txt", 0).reply).toEqual({ entry: null });
  });

  test("a lost listing for a present path refuses instead of reading it as absent", () => {
    const { remaining, reply } = entry("a.txt", 1);
    expect(remaining).toBe(0);
    expect(reply).toMatchObject({ exitCode: 4 });
    expect((reply as { error: string }).error).toContain(
      "its answer was lost; retry the command"
    );
  });

  test("a lost listing for an absent path is still an absence", () => {
    const { remaining, reply } = entry("missing.txt", 1);
    expect(remaining).toBe(0);
    expect(reply).toEqual({ entry: null });
  });
});
