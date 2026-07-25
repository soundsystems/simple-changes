#!/usr/bin/env bun

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fixtureRoot = await mkdtemp(join(tmpdir(), "publish-skill-consumers-"));
const script = resolve(
  import.meta.dir,
  "../../../../skills/publish-skill/scripts/discover-local-consumers.ts"
);

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

const install = async (repository: string, skill: string): Promise<void> => {
  const directory = join(repository, ".agents", "skills", skill);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${skill}\ndescription: Test package for discovery.\n---\n`
  );
};

const lock = (source: string, skill: string) => ({
  skills: {
    [skill]: {
      computedHash: "abc123",
      skillPath: `skills/${skill}/SKILL.md`,
      source,
      sourceType: "gitlab",
    },
  },
  version: 1,
});

afterAll(async () => {
  await rm(fixtureRoot, { force: true, recursive: true });
});

describe("discover-local-consumers", () => {
  test("finds installed, lock-only, and unlocked exact-name consumers", async () => {
    const installed = join(fixtureRoot, "installed");
    const lockOnly = join(fixtureRoot, "lock-only");
    const unlocked = join(fixtureRoot, "unlocked");
    const unrelated = join(fixtureRoot, "unrelated");

    await Promise.all([
      writeJson(
        join(installed, "skills-lock.json"),
        lock("soundsystems/example", "example-skill")
      ),
      writeJson(
        join(lockOnly, "skills-lock.json"),
        lock("soundsystems/example", "example-skill")
      ),
      writeJson(
        join(unrelated, "skills-lock.json"),
        lock("someone/else", "example-skill")
      ),
      install(installed, "example-skill"),
      install(unlocked, "example-skill"),
      install(unrelated, "example-skill"),
    ]);

    const result = spawnSync(
      "bun",
      [
        script,
        "--source",
        "soundsystems/example",
        "--skill",
        "example-skill",
        "--root",
        fixtureRoot,
        "--json",
      ],
      { encoding: "utf8" }
    );

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      consumers: Array<{
        repositoryRoot: string;
        state: string;
      }>;
    };
    expect(
      output.consumers.map(({ repositoryRoot, state }) => ({
        repository: repositoryRoot.split("/").at(-1),
        state,
      }))
    ).toEqual([
      { repository: "installed", state: "installed" },
      { repository: "lock-only", state: "lock-only" },
      { repository: "unlocked", state: "unlocked-install" },
    ]);
  });

  test("ignores other sources and unrequested installed skill names", () => {
    const result = spawnSync(
      "bun",
      [
        script,
        "--source",
        "soundsystems/example",
        "--skill",
        "different-skill",
        "--root",
        fixtureRoot,
        "--json",
      ],
      { encoding: "utf8" }
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).consumers).toEqual([]);
  });

  test("matches full Git URLs to an owner and repository identity", async () => {
    const repository = join(fixtureRoot, "url-source");
    await Promise.all([
      writeJson(
        join(repository, "skills-lock.json"),
        lock("https://gitlab.com/soundsystems/example.git", "example-skill")
      ),
      install(repository, "example-skill"),
    ]);

    const result = spawnSync(
      "bun",
      [
        script,
        "--source",
        "soundsystems/example",
        "--skill",
        "example-skill",
        "--root",
        repository,
        "--json",
      ],
      { encoding: "utf8" }
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).consumers).toMatchObject([
      {
        source: "https://gitlab.com/soundsystems/example.git",
        state: "installed",
      },
    ]);
  });
});
