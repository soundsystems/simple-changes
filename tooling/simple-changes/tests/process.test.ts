import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type GitExecutableProbe,
  resolveGitExecutable,
  runGit,
  runGitConcurrently,
} from "../../../skills/simple-changes/scripts/lib/process.ts";
import { createTestRepository, git, type TestRepository } from "./helpers.ts";

const DEVELOPER_GIT = "/Applications/Xcode.app/Contents/Developer/usr/bin/git";

const probe = (overrides: Partial<GitExecutableProbe>): GitExecutableProbe => ({
  platform: "darwin",
  realpath: (path) => path,
  which: () => "/usr/bin/git",
  xcrunFind: () => DEVELOPER_GIT,
  ...overrides,
});

let repositories: TestRepository[] = [];

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

describe("Git executable resolution", () => {
  test("bypasses the macOS xcrun shim with the binary it would run", () => {
    expect(resolveGitExecutable(probe({}))).toBe(DEVELOPER_GIT);
  });

  test("keeps plain git whenever the shim is not what PATH resolves", () => {
    expect(resolveGitExecutable(probe({ platform: "linux" }))).toBe("git");
    expect(
      resolveGitExecutable(probe({ which: () => "/opt/homebrew/bin/git" }))
    ).toBe("git");
    expect(resolveGitExecutable(probe({ which: () => null }))).toBe("git");
    expect(
      resolveGitExecutable(
        probe({
          realpath: () => {
            throw new Error("dangling link");
          },
        })
      )
    ).toBe("git");
  });

  test("follows a PATH link that resolves to the shim", () => {
    expect(
      resolveGitExecutable(
        probe({
          realpath: () => "/usr/bin/git",
          which: () => "/usr/local/bin/git",
        })
      )
    ).toBe(DEVELOPER_GIT);
  });

  test("keeps plain git when xcrun cannot name a real binary", () => {
    expect(resolveGitExecutable(probe({ xcrunFind: () => null }))).toBe("git");
    expect(resolveGitExecutable(probe({ xcrunFind: () => "git" }))).toBe("git");
    expect(
      resolveGitExecutable(probe({ xcrunFind: () => "/usr/bin/git" }))
    ).toBe("git");
  });
});

describe("Concurrent Git reads", () => {
  test("return the same stdout, in request order, as sequential reads", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const requests = [
      ["rev-parse", "HEAD"],
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      ["log", "--format=%s", "-1"],
      ["ls-files", "--stage", "-z"],
      ["symbolic-ref", "--short", "HEAD"],
    ].map((args) => ({ args, cwd: fixture.root }));

    const concurrent = runGitConcurrently(requests);

    expect(concurrent.map((result) => result.stdout)).toEqual(
      requests.map((request) => runGit(request.cwd, request.args).stdout)
    );
    expect(concurrent.every((result) => result.exitCode === 0)).toBe(true);
  });

  test("raise the same error a sequential read would", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const failing = ["rev-parse", "--verify", "refs/heads/does-not-exist"];
    const requests = [
      ["rev-parse", "HEAD"],
      ["rev-parse", "HEAD"],
      failing,
      ["rev-parse", "HEAD"],
    ].map((args) => ({ args, cwd: fixture.root }));

    let sequentialError: unknown;
    try {
      runGit(fixture.root, failing);
    } catch (error) {
      sequentialError = error;
    }

    expect(sequentialError).toBeInstanceOf(Error);
    expect(() => runGitConcurrently(requests)).toThrow(
      (sequentialError as Error).message
    );
  });

  test("run in the worker rather than the sequential fallback", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    // An ambiguous name succeeds but warns on stderr. Sequential reads keep
    // that warning; worker results carry no stderr, which proves they ran
    // concurrently instead of silently falling back.
    git(fixture.root, ["config", "core.warnAmbiguousRefs", "true"]);
    git(fixture.root, ["tag", "ambiguous"]);
    git(fixture.root, ["branch", "ambiguous"]);
    const requests = Array.from({ length: 4 }, () => ({
      args: ["rev-parse", "ambiguous"],
      cwd: fixture.root,
    }));

    const sequential = runGit(fixture.root, ["rev-parse", "ambiguous"]);
    const concurrent = runGitConcurrently(requests);

    expect(sequential.stderr).toContain("ambiguous");
    expect(concurrent.map((result) => result.stderr)).toEqual(
      requests.map(() => "")
    );
    expect(concurrent.map((result) => result.stdout)).toEqual(
      requests.map(() => sequential.stdout)
    );
  });

  test("re-run a request the worker could not start", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const missing = join(fixture.base, "missing-directory");
    const requests = [fixture.root, fixture.root, missing, fixture.root].map(
      (cwd) => ({ args: ["rev-parse", "HEAD"], cwd })
    );

    let sequentialError: unknown;
    try {
      runGit(missing, ["rev-parse", "HEAD"]);
    } catch (error) {
      sequentialError = error;
    }

    expect(sequentialError).toBeInstanceOf(Error);
    expect(() => runGitConcurrently(requests)).toThrow(
      (sequentialError as Error).message
    );
  });
});
