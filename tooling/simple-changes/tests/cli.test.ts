import { afterEach, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import {
  createTestRepository,
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
