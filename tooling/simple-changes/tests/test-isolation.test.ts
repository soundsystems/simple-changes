import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { dirname, relative } from "node:path";
import { spawnSync } from "bun";
import {
  gitReportedPath,
  locateRepository,
} from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import { createTestRepository } from "./helpers.ts";

// A full check runs from this repository or a worktree that shares its `.git`,
// where other sessions keep live Simple Changes state. A test that falls back
// to the working directory, such as one passing `process.cwd()` as its
// repository or running the CLI without `--repo`, once read that state.
describe("test isolation from the host repository", () => {
  const repositoryCheckout = realpathSync(
    dirname(dirname(dirname(import.meta.dir)))
  );

  test("runs outside every repository, with discovery stopped above it", () => {
    const workingDirectory = realpathSync(process.cwd());
    expect(relative(repositoryCheckout, workingDirectory)).toStartWith("..");
    expect(process.env.GIT_CEILING_DIRECTORIES).toBe(dirname(workingDirectory));
    for (const name of ["GIT_COMMON_DIR", "GIT_DIR", "GIT_WORK_TREE"]) {
      expect(process.env[name]).toBeUndefined();
    }
    const discovery = spawnSync(["git", "rev-parse", "--git-common-dir"], {
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(discovery.exitCode).not.toBe(0);
  });

  test("a lookup from the working directory fails instead of finding a repository", () => {
    expect(() => locateRepository(process.cwd())).toThrow();
  });

  test("an empty Git path answer is refused, never resolved to the working directory", () => {
    // `realpathSync("")` returns the working directory. Under heavy load
    // `rev-parse --show-toplevel` has printed nothing and exited 0, which
    // once made a fixture's lookup land in the repository the run started in.
    expect(realpathSync("")).toBe(realpathSync(process.cwd()));
    for (const output of ["", "\n", "\r\n"]) {
      expect(() => gitReportedPath(output, "--show-toplevel")).toThrow(
        "printed no path"
      );
    }
    expect(gitReportedPath("/repo\n", "--show-toplevel")).toBe("/repo");
  });

  test("fixture repositories still resolve to themselves", () => {
    const fixture = createTestRepository();
    try {
      expect(locateRepository(fixture.root).repository.commonGitDirectory).toBe(
        realpathSync(`${fixture.root}/.git`)
      );
    } finally {
      fixture.cleanup();
    }
  });
});
