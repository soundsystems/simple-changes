import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "bun";

const temporaryDirectories: string[] = [];
const helper = new URL("../check-fork-sync.sh", import.meta.url).pathname;

const run = (cwd: string, argv: string[]) => {
  const result = spawnSync(argv, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
};

const git = (cwd: string, ...args: string[]): string => {
  const result = run(cwd, ["git", ...args]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return result.stdout.trim();
};

const commitSkill = async (
  repository: string,
  contents: string,
  subject: string
): Promise<string> => {
  const skill = join(repository, "skills", "simple-changes", "SKILL.md");
  await mkdir(dirname(skill), { recursive: true });
  await writeFile(skill, contents);
  git(repository, "add", "--all");
  git(repository, "commit", "-m", subject, "--no-gpg-sign", "--no-verify");
  return git(repository, "rev-parse", "HEAD");
};

const setupRepository = async () => {
  const root = await mkdtemp(join(tmpdir(), "simple-changes-fork-sync-"));
  temporaryDirectories.push(root);
  const repository = join(root, "upstream");
  const forkSkill = join(root, "fork", "SKILL.md");
  await mkdir(repository);
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.name", "Fork Sync Test");
  git(repository, "config", "user.email", "fork-sync@example.invalid");
  const base = await commitSkill(
    repository,
    "# Simple Changes\n",
    "base skill"
  );
  const main = await commitSkill(
    repository,
    "# Simple Changes\n\nUpdated.\n",
    "update skill"
  );
  await mkdir(dirname(forkSkill), { recursive: true });
  return { base, forkSkill, main, repository };
};

const pinFork = (path: string, pin: string): Promise<void> =>
  writeFile(
    path,
    `# Project Simple Changes\n\nForked from \`simple-changes\` @ \`${pin}\`. Project-specific deltas: policy.\n`
  );

const check = (repository: string, forkSkill: string, ref = "main") =>
  run(repository, ["sh", helper, forkSkill, repository, ref]);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("Simple Changes fork sync checker", () => {
  test("reports a current pin", async () => {
    const fixture = await setupRepository();
    await pinFork(fixture.forkSkill, fixture.main);

    const result = check(fixture.repository, fixture.forkSkill);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("fork is current");
  });

  test("reports newer canonical skill commits", async () => {
    const fixture = await setupRepository();
    await pinFork(fixture.forkSkill, fixture.base);

    const result = check(fixture.repository, fixture.forkSkill);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("newer commit");
    expect(result.stdout).toContain("update skill");
  });

  test("rejects malformed pins and missing refs", async () => {
    const fixture = await setupRepository();
    await writeFile(
      fixture.forkSkill,
      "Forked from `simple-changes` without a pin.\n"
    );
    const malformed = check(fixture.repository, fixture.forkSkill);
    await pinFork(fixture.forkSkill, fixture.main);
    const missingRef = check(fixture.repository, fixture.forkSkill, "missing");

    expect(malformed.exitCode).toBe(2);
    expect(malformed.stderr).toContain("provenance pin");
    expect(missingRef.exitCode).toBe(2);
    expect(missingRef.stderr).toContain("ref");
  });

  test("distinguishes a divergent pin", async () => {
    const fixture = await setupRepository();
    git(fixture.repository, "switch", "-c", "divergent", fixture.base);
    const divergent = await commitSkill(
      fixture.repository,
      "# Simple Changes\n\nDivergent.\n",
      "divergent skill"
    );
    await pinFork(fixture.forkSkill, divergent);

    const result = check(fixture.repository, fixture.forkSkill, "main");

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("diverg");
  });
});
