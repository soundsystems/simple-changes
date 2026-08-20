#!/usr/bin/env bun

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  await installAt(repository, ".agents", skill);
};

const installAt = async (
  repository: string,
  agentRoot: ".agents" | ".claude",
  skill: string
): Promise<void> => {
  const directory = join(repository, agentRoot, "skills", skill);
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

  test("counts symlinked paths as one physical installation", async () => {
    const repository = join(fixtureRoot, "aliased-install");
    await Promise.all([
      writeJson(
        join(repository, "skills-lock.json"),
        lock("soundsystems/example", "example-skill")
      ),
      install(repository, "example-skill"),
    ]);
    await mkdir(join(repository, ".claude", "skills"), { recursive: true });
    await symlink(
      "../../.agents/skills/example-skill",
      join(repository, ".claude", "skills", "example-skill")
    );

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
    const physicalInstall = join(
      repository,
      ".agents",
      "skills",
      "example-skill"
    );
    expect(JSON.parse(result.stdout).consumers).toMatchObject([
      {
        installationCount: 1,
        physicalInstallPaths: [
          join(repository, ".agents", "skills", "example-skill"),
        ],
        resolvedInstallPaths: [await realpath(physicalInstall)],
        state: "installed",
        symlinkPaths: [join(repository, ".claude", "skills", "example-skill")],
      },
    ]);
    expect(JSON.parse(result.stdout).consumers[0].installPaths).toHaveLength(2);
  });

  test("reports distinct physical copies as multiple installations", async () => {
    const repository = join(fixtureRoot, "duplicate-install");
    await Promise.all([
      writeJson(
        join(repository, "skills-lock.json"),
        lock("soundsystems/example", "example-skill")
      ),
      installAt(repository, ".agents", "example-skill"),
      installAt(repository, ".claude", "example-skill"),
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
    const physicalInstallPaths = [
      join(repository, ".agents", "skills", "example-skill"),
      join(repository, ".claude", "skills", "example-skill"),
    ];
    expect(JSON.parse(result.stdout).consumers).toMatchObject([
      {
        installationCount: 2,
        physicalInstallPaths: [
          join(repository, ".agents", "skills", "example-skill"),
          join(repository, ".claude", "skills", "example-skill"),
        ],
        resolvedInstallPaths: (
          await Promise.all(physicalInstallPaths.map((path) => realpath(path)))
        ).sort(),
        state: "multiple-installs",
        symlinkPaths: [],
      },
    ]);
  });
});
