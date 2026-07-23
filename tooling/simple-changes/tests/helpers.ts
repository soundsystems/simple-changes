import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";

const decoder = new TextDecoder();

export const git = (cwd: string, args: string[]): string => {
  const result = spawnSync(["git", "-C", cwd, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const stdout = decoder.decode(result.stdout);
  const stderr = decoder.decode(result.stderr);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return stdout.trim();
};

export interface TestRepository {
  base: string;
  cleanup: () => void;
  root: string;
}

export const createTestRepository = (): TestRepository => {
  const temporaryBase = mkdtempSync(join(tmpdir(), "simple-changes-test-"));
  const base = realpathSync(temporaryBase);
  const repositoryPath = join(base, "repo");
  mkdirSync(repositoryPath);
  const root = realpathSync(repositoryPath);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Simple Changes Tests"]);
  git(root, ["config", "user.email", "tests@simple-changes.invalid"]);
  writeFileSync(join(root, "README.md"), "# Fixture\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "Initial fixture"]);
  return {
    base,
    cleanup: () => rmSync(temporaryBase, { force: true, recursive: true }),
    root,
  };
};

export const writeFixture = (
  root: string,
  relativePath: string,
  contents: string
): void => {
  const path = join(root, relativePath);
  const separator = relativePath.lastIndexOf("/");
  if (separator >= 0) {
    mkdirSync(join(root, relativePath.slice(0, separator)), {
      recursive: true,
    });
  }
  writeFileSync(path, contents);
};
