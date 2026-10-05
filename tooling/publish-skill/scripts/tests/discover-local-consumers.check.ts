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
const bun = process.execPath;
// Discovery also scans global skill roots under HOME, so every run gets an
// empty fixture HOME; otherwise real installs on this machine leak in.
const isolatedEnv = { ...process.env, HOME: join(fixtureRoot, "empty-home") };

interface ConsumerSummary {
  repositoryRoot: string;
  skill: string;
  state: string;
}

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

const install = async (repository: string, skill: string): Promise<void> => {
  await installAt(repository, ".agents", skill);
};

const installAt = async (
  repository: string,
  agentRoot: ".agents" | ".claude" | ".codex",
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

const webCmsPolicy = {
  developerChangelog: "required",
  distribution: "web-cms",
  guidance: {
    backfillStatus: "completed",
    version: 9,
  },
  newReleaseNoteSurfaces: "ask",
  schemaVersion: 1,
  signatures: "agent-and-timestamp",
};

const combinedLocks = (
  cmsSource = "soundsystems/simple-changelogs",
  webCmsSource = cmsSource
) => ({
  skills: {
    "simple-changelogs-cms": {
      computedHash: "cms-hash",
      skillPath: "skills/simple-changelogs-cms/SKILL.md",
      source: cmsSource,
      sourceType: "gitlab",
    },
    "simple-changelogs-web-cms": {
      computedHash: "web-cms-hash",
      skillPath: "skills/simple-changelogs-web-cms/SKILL.md",
      source: webCmsSource,
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
      bun,
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
      { encoding: "utf8", env: isolatedEnv }
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
      bun,
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
      { encoding: "utf8", env: isolatedEnv }
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
      bun,
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
      { encoding: "utf8", env: isolatedEnv }
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
      bun,
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
      { encoding: "utf8", env: isolatedEnv }
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
      bun,
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
      { encoding: "utf8", env: isolatedEnv }
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

  test("marks standalone CMS as superseded by a selected Web and CMS package", async () => {
    const repository = join(fixtureRoot, "web-cms-topology");
    await Promise.all([
      writeJson(join(repository, ".simple-changelogs.json"), webCmsPolicy),
      writeJson(join(repository, ".simple-changelogs-cms.json"), {
        schemaVersion: 1,
      }),
      writeJson(join(repository, "skills-lock.json"), combinedLocks()),
      install(repository, "simple-changelogs-cms"),
      install(repository, "simple-changelogs-web-cms"),
    ]);

    const result = spawnSync(
      bun,
      [
        script,
        "--source",
        "soundsystems/simple-changelogs",
        "--skill",
        "simple-changelogs-cms",
        "--skill",
        "simple-changelogs-web-cms",
        "--root",
        repository,
        "--json",
      ],
      { encoding: "utf8", env: isolatedEnv }
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).consumers).toMatchObject([
      {
        skill: "simple-changelogs-cms",
        state: "superseded-install",
        supersededBy: "simple-changelogs-web-cms",
      },
      {
        skill: "simple-changelogs-web-cms",
        state: "installed",
      },
    ]);
  });

  test("keeps standalone CMS while the CMS policy sidecar is missing", async () => {
    const repository = join(fixtureRoot, "web-cms-without-sidecar");
    await Promise.all([
      writeJson(join(repository, ".simple-changelogs.json"), webCmsPolicy),
      writeJson(join(repository, "skills-lock.json"), combinedLocks()),
      install(repository, "simple-changelogs-cms"),
      install(repository, "simple-changelogs-web-cms"),
    ]);

    const result = spawnSync(
      bun,
      [
        script,
        "--source",
        "soundsystems/simple-changelogs",
        "--skill",
        "simple-changelogs-cms",
        "--skill",
        "simple-changelogs-web-cms",
        "--root",
        repository,
        "--json",
      ],
      { encoding: "utf8", env: isolatedEnv }
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).consumers).toMatchObject([
      { skill: "simple-changelogs-cms", state: "installed" },
      { skill: "simple-changelogs-web-cms", state: "installed" },
    ]);
  });

  test("does not supersede CMS from invalid policy or a lock-only combined package", async () => {
    const invalidPolicy = join(fixtureRoot, "invalid-web-cms-policy");
    const lockOnlyCombined = join(fixtureRoot, "lock-only-web-cms");
    await Promise.all([
      writeJson(join(invalidPolicy, ".simple-changelogs.json"), {
        distribution: "web-cms",
        schemaVersion: 1,
      }),
      writeJson(join(invalidPolicy, "skills-lock.json"), combinedLocks()),
      install(invalidPolicy, "simple-changelogs-cms"),
      install(invalidPolicy, "simple-changelogs-web-cms"),
      writeJson(
        join(lockOnlyCombined, ".simple-changelogs.json"),
        webCmsPolicy
      ),
      writeJson(join(lockOnlyCombined, "skills-lock.json"), combinedLocks()),
      install(lockOnlyCombined, "simple-changelogs-cms"),
    ]);

    const result = spawnSync(
      bun,
      [
        script,
        "--source",
        "soundsystems/simple-changelogs",
        "--skill",
        "simple-changelogs-cms",
        "--skill",
        "simple-changelogs-web-cms",
        "--root",
        invalidPolicy,
        "--root",
        lockOnlyCombined,
        "--json",
      ],
      { encoding: "utf8", env: isolatedEnv }
    );

    expect(result.status).toBe(0);
    expect(
      JSON.parse(result.stdout).consumers.map(
        ({ repositoryRoot, skill, state }: ConsumerSummary) => ({
          repository: repositoryRoot.split("/").at(-1),
          skill,
          state,
        })
      )
    ).toEqual([
      {
        repository: "invalid-web-cms-policy",
        skill: "simple-changelogs-cms",
        state: "installed",
      },
      {
        repository: "invalid-web-cms-policy",
        skill: "simple-changelogs-web-cms",
        state: "installed",
      },
      {
        repository: "lock-only-web-cms",
        skill: "simple-changelogs-cms",
        state: "installed",
      },
      {
        repository: "lock-only-web-cms",
        skill: "simple-changelogs-web-cms",
        state: "lock-only",
      },
    ]);
  });

  test("does not supersede CMS from an unlocked combined package", async () => {
    const repository = join(fixtureRoot, "unlocked-web-cms");
    await Promise.all([
      writeJson(join(repository, ".simple-changelogs.json"), webCmsPolicy),
      writeJson(
        join(repository, "skills-lock.json"),
        lock("soundsystems/simple-changelogs", "simple-changelogs-cms")
      ),
      install(repository, "simple-changelogs-cms"),
      install(repository, "simple-changelogs-web-cms"),
    ]);

    const result = spawnSync(
      bun,
      [
        script,
        "--source",
        "soundsystems/simple-changelogs",
        "--skill",
        "simple-changelogs-cms",
        "--skill",
        "simple-changelogs-web-cms",
        "--root",
        repository,
        "--json",
      ],
      { encoding: "utf8", env: isolatedEnv }
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).consumers).toMatchObject([
      {
        skill: "simple-changelogs-cms",
        state: "installed",
      },
      {
        skill: "simple-changelogs-web-cms",
        state: "unlocked-install",
      },
    ]);
  });

  test("does not supersede across sources or repository roots", async () => {
    const sourceMismatch = join(fixtureRoot, "source-mismatch");
    const cmsRepository = join(fixtureRoot, "separate-cms-repository");
    const webCmsRepository = join(fixtureRoot, "separate-web-cms-repository");
    await Promise.all([
      writeJson(join(sourceMismatch, ".simple-changelogs.json"), webCmsPolicy),
      writeJson(
        join(sourceMismatch, "skills-lock.json"),
        combinedLocks(
          "soundsystems/simple-changelogs",
          "someone-else/simple-changelogs"
        )
      ),
      install(sourceMismatch, "simple-changelogs-cms"),
      install(sourceMismatch, "simple-changelogs-web-cms"),
      writeJson(join(cmsRepository, ".simple-changelogs.json"), webCmsPolicy),
      writeJson(
        join(cmsRepository, "skills-lock.json"),
        lock("soundsystems/simple-changelogs", "simple-changelogs-cms")
      ),
      install(cmsRepository, "simple-changelogs-cms"),
      writeJson(
        join(webCmsRepository, "skills-lock.json"),
        lock("soundsystems/simple-changelogs", "simple-changelogs-web-cms")
      ),
      install(webCmsRepository, "simple-changelogs-web-cms"),
    ]);

    const result = spawnSync(
      bun,
      [
        script,
        "--source",
        "soundsystems/simple-changelogs",
        "--skill",
        "simple-changelogs-cms",
        "--skill",
        "simple-changelogs-web-cms",
        "--root",
        sourceMismatch,
        "--root",
        cmsRepository,
        "--root",
        webCmsRepository,
        "--json",
      ],
      { encoding: "utf8", env: isolatedEnv }
    );

    expect(result.status).toBe(0);
    expect(
      JSON.parse(result.stdout).consumers.some(
        (consumer: { state: string }) => consumer.state === "superseded-install"
      )
    ).toBe(false);
  });

  test("automatically discovers global installs and deduplicates aliases", async () => {
    const home = join(fixtureRoot, "global-home");
    await installAt(home, ".agents", "example-skill");
    await mkdir(join(home, ".codex", "skills"), { recursive: true });
    await symlink(
      "../../.agents/skills/example-skill",
      join(home, ".codex", "skills", "example-skill")
    );

    const result = spawnSync(
      bun,
      [
        script,
        "--source",
        "soundsystems/example",
        "--skill",
        "example-skill",
        "--root",
        home,
        "--json",
      ],
      { encoding: "utf8", env: { ...process.env, HOME: home } }
    );

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      consumers: Array<{
        installationCount: number;
        installPaths: string[];
        repositoryRoot: string;
        state: string;
        symlinkPaths: string[];
      }>;
      globalSearchRoots: string[];
    };
    expect(output.globalSearchRoots).toContain(join(home, ".agents", "skills"));
    expect(
      output.consumers.find((consumer) => consumer.repositoryRoot === home)
    ).toMatchObject({
      installationCount: 1,
      installPaths: [
        join(home, ".agents", "skills", "example-skill"),
        join(home, ".codex", "skills", "example-skill"),
      ],
      repositoryRoot: home,
      state: "unlocked-install",
      symlinkPaths: [join(home, ".codex", "skills", "example-skill")],
    });
  });
});
