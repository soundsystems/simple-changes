import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

const decoder = new TextDecoder();
const testDirectory = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(
  testDirectory,
  "../../../skills/simple-changes/scripts/simple-changes.ts"
);
let repositories: TestRepository[] = [];

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

describe("contract CLI", () => {
  test("reports onboarding before a first write-capable run", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const configurationRoot = resolve(fixture.base, "configuration");
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "initialize",
        "--mode",
        "queue",
        "--json",
        "--repo",
        fixture.root,
      ],
      {
        env: {
          ...process.env,
          SIMPLE_CHANGES_CONFIG_DIR: configurationRoot,
        },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      inferredDefaultFinish: string;
      onboardingRequired: boolean;
      writeCapable: boolean;
    };

    expect(result.exitCode).toBe(0);
    expect(output).toMatchObject({
      inferredDefaultFinish: "open-change-request",
      onboardingRequired: true,
      writeCapable: true,
    });
  });

  test("does not onboard a first preview run", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "initialize",
        "--mode",
        "preview",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      onboardingRequired: boolean;
      writeCapable: boolean;
    };

    expect(result.exitCode).toBe(0);
    expect(output).toMatchObject({
      onboardingRequired: false,
      writeCapable: false,
    });
  });

  test("automatically runs setup during non-interactive initialization when answers are complete", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const configurationRoot = resolve(fixture.base, "configuration");
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "initialize",
        "--mode",
        "integrate",
        "--questions",
        "blocking-only",
        "--scope",
        "repository",
        "--yes",
        "--json",
        "--repo",
        fixture.root,
      ],
      {
        env: {
          ...process.env,
          SIMPLE_CHANGES_CONFIG_DIR: configurationRoot,
        },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      policy: {
        defaultFinish: string;
      };
      written: boolean;
    };
    const policy = JSON.parse(
      readFileSync(resolve(fixture.root, ".simple-changes.json"), "utf8")
    ) as {
      defaultFinish: string;
    };

    expect(result.exitCode).toBe(0);
    expect(output).toMatchObject({
      policy: {
        defaultFinish: "integrate",
      },
      written: true,
    });
    expect(policy.defaultFinish).toBe("integrate");

    const repeated = spawnSync(
      [
        process.execPath,
        cliPath,
        "initialize",
        "--mode",
        "ship",
        "--json",
        "--repo",
        fixture.root,
      ],
      {
        env: {
          ...process.env,
          SIMPLE_CHANGES_CONFIG_DIR: configurationRoot,
        },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const repeatedOutput = JSON.parse(decoder.decode(repeated.stdout)) as {
      onboardingRequired: boolean;
      policySource: string;
    };
    expect(repeated.exitCode).toBe(0);
    expect(repeatedOutput).toMatchObject({
      onboardingRequired: false,
      policySource: "repository",
    });
  });

  test("supports global personal setup outside a Git repository", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const configurationRoot = resolve(fixture.base, "configuration");
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "ship",
        "--production",
        "ask",
        "--questions",
        "blocking-only",
        "--scope",
        "user",
        "--yes",
        "--json",
      ],
      {
        cwd: fixture.base,
        env: {
          ...process.env,
          SIMPLE_CHANGES_CONFIG_DIR: configurationRoot,
        },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const personalPath = resolve(
      configurationRoot,
      "simple-changes",
      "preferences.json"
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      path: string;
      policy: {
        defaultFinish: string;
      };
      written: boolean;
    };

    expect(result.exitCode).toBe(0);
    expect(output).toMatchObject({
      path: personalPath,
      policy: {
        defaultFinish: "ship",
      },
      written: true,
    });

    const initialized = spawnSync(
      [
        process.execPath,
        cliPath,
        "initialize",
        "--mode",
        "queue",
        "--json",
        "--repo",
        fixture.root,
      ],
      {
        env: {
          ...process.env,
          SIMPLE_CHANGES_CONFIG_DIR: configurationRoot,
        },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const initializedOutput = JSON.parse(
      decoder.decode(initialized.stdout)
    ) as {
      onboardingRequired: boolean;
      policySource: string;
    };
    expect(initialized.exitCode).toBe(0);
    expect(initializedOutput).toMatchObject({
      onboardingRequired: false,
      policySource: "user",
    });
  });

  test("rejects repository-scoped setup outside a Git repository", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "review",
        "--questions",
        "blocking-only",
        "--scope",
        "repository",
        "--yes",
      ],
      {
        cwd: fixture.base,
        stderr: "pipe",
        stdout: "pipe",
      }
    );

    expect(result.exitCode).toBe(2);
    expect(decoder.decode(result.stderr)).toContain(
      "Repository-scoped setup requires a Git repository"
    );
  });

  test("requires an explicit changelog preference when surfaces are present", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(fixture.root, "CHANGELOG.md", "# Changelog\n");
    const incomplete = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "review",
        "--questions",
        "blocking-only",
        "--scope",
        "run",
        "--yes",
        "--repo",
        fixture.root,
      ],
      {
        env: {
          ...process.env,
          SIMPLE_CHANGES_SKILL_ROOTS: "",
        },
        stderr: "pipe",
        stdout: "pipe",
      }
    );

    expect(incomplete.exitCode).toBe(2);
    expect(decoder.decode(incomplete.stderr)).toContain(
      "--changelog when relevant"
    );

    const complete = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "review",
        "--changelog",
        "delegate-if-available",
        "--questions",
        "blocking-only",
        "--scope",
        "run",
        "--yes",
        "--json",
        "--repo",
        fixture.root,
      ],
      {
        env: {
          ...process.env,
          SIMPLE_CHANGES_SKILL_ROOTS: "",
        },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const output = JSON.parse(decoder.decode(complete.stdout)) as {
      policy: {
        changelogHandling: string;
      };
    };

    expect(complete.exitCode).toBe(0);
    expect(output.policy.changelogHandling).toBe("delegate-if-available");
  });

  test("returns run-only onboarding preferences without writing a file", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "ship",
        "--production",
        "allow",
        "--questions",
        "never",
        "--scope",
        "run",
        "--yes",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      confirmed: boolean;
      path: string | null;
      policy: {
        defaultFinish: string;
        productionDeploy: string;
        questions: string;
      };
      written: boolean;
    };

    expect(result.exitCode).toBe(0);
    expect(output).toMatchObject({
      confirmed: true,
      path: null,
      policy: {
        defaultFinish: "ship",
        productionDeploy: "allow",
        questions: "never",
      },
      written: false,
    });
  });

  test("saves repository onboarding preferences in the primary checkout", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "integrate",
        "--questions",
        "blocking-only",
        "--scope",
        "repository",
        "--yes",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      path: string;
      written: boolean;
    };
    const policy = JSON.parse(
      readFileSync(resolve(fixture.root, ".simple-changes.json"), "utf8")
    ) as {
      defaultFinish: string;
      productionDeploy: string;
    };

    expect(result.exitCode).toBe(0);
    expect(output.written).toBe(true);
    expect(output.path).toBe(resolve(fixture.root, ".simple-changes.json"));
    expect(policy).toMatchObject({
      defaultFinish: "integrate",
      productionDeploy: "ask",
    });
  });

  test("saves personal preferences outside the repository", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const configurationRoot = resolve(fixture.base, "configuration");
    const environment = {
      ...process.env,
      SIMPLE_CHANGES_CONFIG_DIR: configurationRoot,
    };
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "review",
        "--questions",
        "always",
        "--scope",
        "user",
        "--yes",
        "--json",
        "--repo",
        fixture.root,
      ],
      {
        env: environment,
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const personalPath = resolve(
      configurationRoot,
      "simple-changes",
      "preferences.json"
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      path: string;
      written: boolean;
    };

    expect(result.exitCode).toBe(0);
    expect(output).toMatchObject({
      path: personalPath,
      written: true,
    });
    expect(
      JSON.parse(readFileSync(personalPath, "utf8")) as {
        questions: string;
      }
    ).toMatchObject({ questions: "always" });

    const inventoryResult = spawnSync(
      [
        process.execPath,
        cliPath,
        "inventory",
        "--json",
        "--repo",
        fixture.root,
      ],
      { env: environment, stderr: "pipe", stdout: "pipe" }
    );
    const inventory = JSON.parse(decoder.decode(inventoryResult.stdout)) as {
      policy: {
        path: string;
        source: string;
      };
    };
    expect(inventoryResult.exitCode).toBe(0);
    expect(inventory.policy).toEqual(
      expect.objectContaining({
        path: personalPath,
        source: "user",
      })
    );
  }, 15_000);

  test("saves repository preferences in the canonical primary checkout", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const linkedWorktree = resolve(fixture.base, "linked");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "onboarding-test",
      linkedWorktree,
    ]);
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "review",
        "--questions",
        "blocking-only",
        "--scope",
        "repository",
        "--yes",
        "--json",
        "--repo",
        linkedWorktree,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      path: string;
      written: boolean;
    };

    expect(result.exitCode).toBe(0);
    expect(output).toEqual(
      expect.objectContaining({
        path: resolve(fixture.root, ".simple-changes.json"),
        written: true,
      })
    );
  });

  test("requires complete answers and confirmation without a terminal", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "ship",
        "--questions",
        "never",
        "--scope",
        "run",
        "--yes",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );

    expect(result.exitCode).toBe(2);
    expect(decoder.decode(result.stderr)).toContain(
      "Interactive setup requires a terminal"
    );
  });

  test("emits a validated JSON preview with stable success status", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(fixture.root, "src/ready.ts", "export const ready = true;\n");
    const result = spawnSync(
      [process.execPath, cliPath, "preview", "--json", "--repo", fixture.root],
      { stderr: "pipe", stdout: "pipe" }
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      mode: string;
      mutationCount: number;
      units: unknown[];
    };
    expect(result.exitCode).toBe(0);
    expect(output.mode).toBe("preview");
    expect(output.mutationCount).toBe(0);
    expect(output.units).toHaveLength(1);
  });

  test("uses stable usage exit code for an unknown command", () => {
    const result = spawnSync([process.execPath, cliPath, "does-not-exist"], {
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode).toBe(2);
    expect(decoder.decode(result.stderr)).toContain("Unknown command");
  });

  test("renders public release notes from the latest released changelog section", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      "CHANGELOG.md",
      `# Changelog

## Unreleased

- Keep this pending.

## 0.2.0 - 2026-07-23

<!-- private release metadata -->
- Added release notes to the CLI.
`
    );
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "release-notes",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      markdown: string;
      version: string;
    };

    expect(result.exitCode).toBe(0);
    expect(output.version).toBe("0.2.0");
    expect(output.markdown).toContain("Added release notes to the CLI.");
    expect(output.markdown).not.toContain("private release metadata");
    expect(output.markdown).not.toContain("Keep this pending.");
  });

  test("defaults release notes to the packaged Simple Changes changelog", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      "CHANGELOG.md",
      "# Changelog\n\n## 99.0.0 - 2099-01-01\n\n- Wrong repository.\n"
    );
    const result = spawnSync(
      [process.execPath, cliPath, "release-notes", "--json"],
      { cwd: fixture.root, stderr: "pipe", stdout: "pipe" }
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      markdown: string;
      source: string;
      version: string;
    };

    expect(result.exitCode).toBe(0);
    expect(output.version).not.toBe("99.0.0");
    expect(output.markdown).not.toContain("Wrong repository.");
    expect(output.source).toEndWith("/simple-changes/CHANGELOG.md");
  });

  test("selects a release-note version from the CLI", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      "CHANGELOG.md",
      `# Changelog

## 0.2.0 - 2026-07-23

- New notes.

## 0.1.0 - 2026-07-01

- Original notes.
`
    );
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "release-notes",
        "--repo",
        fixture.root,
        "--version",
        "0.1.0",
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const output = decoder.decode(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(output).toContain("## 0.1.0 - 2026-07-01");
    expect(output).toContain("Original notes.");
    expect(output).not.toContain("New notes.");
  });

  test("checks release consistency with a stable validation exit code", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      "CHANGELOG.md",
      "# Changelog\n\n## 0.2.0 - 2026-07-23\n\n- Public notes.\n"
    );
    writeFixture(
      fixture.root,
      "DEVELOPER_CHANGELOG.md",
      "# Developer changelog\n\n## 0.1.0 - 2026-07-23\n\n- Developer notes.\n"
    );
    writeFixture(
      fixture.root,
      "package.json",
      '{ "name": "fixture", "version": "0.2.0" }\n'
    );
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "release-notes",
        "--check",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      issues: string[];
      valid: boolean;
    };

    expect(result.exitCode).toBe(3);
    expect(output.valid).toBe(false);
    expect(output.issues).toContain(
      "developer-history version 0.1.0 does not match public release 0.2.0."
    );
  });

  test("rejects conflicting release-note selectors", () => {
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "release-notes",
        "--check",
        "--version",
        "0.2.0",
      ],
      { stderr: "pipe", stdout: "pipe" }
    );

    expect(result.exitCode).toBe(2);
    expect(decoder.decode(result.stderr)).toContain(
      "--check and --version cannot be combined"
    );
  });

  test("requires an explicit repository for maintainer consistency checks", () => {
    const result = spawnSync(
      [process.execPath, cliPath, "release-notes", "--check"],
      { stderr: "pipe", stdout: "pipe" }
    );

    expect(result.exitCode).toBe(2);
    expect(decoder.decode(result.stderr)).toContain(
      "--check requires an explicit --repo PATH"
    );
  });
});
