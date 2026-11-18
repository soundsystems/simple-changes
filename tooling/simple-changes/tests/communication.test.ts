import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import {
  assertCommunicationWritable,
  CHANGELOGS_REPOSITORY_COMMUNICATION_FILENAME,
  communicationPaths,
  REPOSITORY_COMMUNICATION_FILENAME,
  resolveCommunication,
  writeCommunication,
} from "../../../skills/simple-changes/scripts/lib/communication.ts";
import {
  DEFAULT_POLICY,
  policyEntryExists,
  writeRepositoryPolicyTrustReceipt,
} from "../../../skills/simple-changes/scripts/lib/policy.ts";
import { resolveTestTimeoutMs } from "../../test-timeout.ts";
import { createTestRepository, git, type TestRepository } from "./helpers.ts";

setDefaultTimeout(resolveTestTimeoutMs());

const cliPath = fileURLToPath(
  new URL(
    "../../../skills/simple-changes/scripts/simple-changes.ts",
    import.meta.url
  )
);
const libraryDirectory = fileURLToPath(
  new URL("../../../skills/simple-changes/scripts/lib", import.meta.url)
);
const decoder = new TextDecoder();
let repositories: TestRepository[] = [];
let scratch: string[] = [];

afterEach(() => {
  for (const repository of repositories) {
    repository.cleanup();
  }
  for (const directory of scratch) {
    rmSync(directory, { force: true, recursive: true });
  }
  repositories = [];
  scratch = [];
});

const temporary = (label: string): string => {
  const path = realpathSync(
    mkdtempSync(join(tmpdir(), `communication-${label}-`))
  );
  scratch.push(path);
  return path;
};

const repository = (): TestRepository => {
  const fixture = createTestRepository();
  repositories.push(fixture);
  return fixture;
};

const runCli = (
  args: string[],
  env: Record<string, string>
): { exitCode: number; stderr: string; stdout: string } => {
  const result = spawnSync([process.execPath, cliPath, ...args], {
    env: { ...process.env, ...env },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: decoder.decode(result.stderr),
    stdout: decoder.decode(result.stdout),
  };
};

const sidecar = (style: string, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ schemaVersion: 1, style, ...extra }, null, 2)}\n`;

describe("communication style resolution", () => {
  test("is standard when nothing is saved", () => {
    const fixture = repository();
    const environment = { SIMPLE_CHANGES_CONFIG_DIR: temporary("config") };
    expect(resolveCommunication(fixture.root, { environment })).toEqual({
      errors: [],
      path: null,
      source: "default",
      style: "standard",
    });
    expect(resolveCommunication(null, { environment }).style).toBe("standard");
  });

  test("reads the repository sidecar, and lets the person's own setting outrank it", () => {
    const fixture = repository();
    const config = temporary("config");
    const environment = { SIMPLE_CHANGES_CONFIG_DIR: config };
    const paths = communicationPaths(fixture.root, { environment });
    expect(paths.repository).toBe(
      join(fixture.root, REPOSITORY_COMMUNICATION_FILENAME)
    );
    expect(paths.personal).toBe(
      join(config, "simple-changes", "communication.json")
    );

    writeFileSync(paths.repository as string, sidecar("ultra-simple"));
    expect(resolveCommunication(fixture.root, { environment })).toEqual({
      errors: [],
      path: paths.repository,
      source: "repository",
      style: "ultra-simple",
    });

    // An owner sets the project to Ultra-Simple and keeps full detail
    // personally: the style grants nothing, so the person's choice wins.
    mkdirSync(join(config, "simple-changes"), { recursive: true });
    writeFileSync(paths.personal, sidecar("standard"));
    expect(resolveCommunication(fixture.root, { environment })).toEqual({
      errors: [],
      path: paths.personal,
      source: "personal",
      style: "standard",
    });
  });

  test("follows the Simple Changelogs sidecar only when Simple Changes has none", () => {
    const fixture = repository();
    const environment = { SIMPLE_CHANGES_CONFIG_DIR: temporary("config") };
    const companion = join(
      fixture.root,
      CHANGELOGS_REPOSITORY_COMMUNICATION_FILENAME
    );
    writeFileSync(companion, sidecar("ultra-simple"));
    expect(resolveCommunication(fixture.root, { environment })).toEqual({
      errors: [],
      path: companion,
      source: "companion",
      style: "ultra-simple",
    });

    const own = join(fixture.root, REPOSITORY_COMMUNICATION_FILENAME);
    writeFileSync(own, sidecar("standard"));
    expect(resolveCommunication(fixture.root, { environment })).toMatchObject({
      path: own,
      source: "repository",
      style: "standard",
    });
  });

  test("reports and skips a sidecar it cannot use, falling back to the next layer", () => {
    const fixture = repository();
    const environment = { SIMPLE_CHANGES_CONFIG_DIR: temporary("config") };
    const own = join(fixture.root, REPOSITORY_COMMUNICATION_FILENAME);
    const unusable: [string, string][] = [
      ["{ not json", "is not valid JSON"],
      ["[]", "must hold a JSON object"],
      [sidecar("loud"), "style must be ultra-simple or standard"],
      [
        JSON.stringify({ schemaVersion: 2, style: "ultra-simple" }),
        "schemaVersion must be 1",
      ],
    ];
    for (const [text, reason] of unusable) {
      writeFileSync(own, text);
      const report = resolveCommunication(fixture.root, { environment });
      expect(report.style).toBe("standard");
      expect(report.source).toBe("default");
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]).toContain(reason);
    }

    // A symbolic link is never followed, even to a valid file.
    const target = join(temporary("target"), "communication.json");
    writeFileSync(target, sidecar("ultra-simple"));
    rmSync(own);
    symlinkSync(target, own);
    const linked = resolveCommunication(fixture.root, { environment });
    expect(linked.style).toBe("standard");
    expect(linked.errors[0]).toContain("is not a regular file");

    // Nor is a dangling link an absent sidecar a later write may replace.
    rmSync(target);
    const dangling = resolveCommunication(fixture.root, { environment });
    expect(dangling.style).toBe("standard");
    expect(dangling.errors).toEqual([`${own} is not a regular file`]);
  });

  test("reports a broken project sidecar even when a personal setting decides", () => {
    const fixture = repository();
    const config = temporary("config");
    const environment = { SIMPLE_CHANGES_CONFIG_DIR: config };
    const paths = communicationPaths(fixture.root, { environment });
    mkdirSync(join(config, "simple-changes"), { recursive: true });
    writeFileSync(paths.personal, sidecar("ultra-simple"));
    writeFileSync(paths.repository as string, "{ not json");
    writeFileSync(paths.companion as string, "[]");
    expect(resolveCommunication(fixture.root, { environment })).toEqual({
      errors: [
        `${paths.repository} is not valid JSON`,
        `${paths.companion} must hold a JSON object`,
      ],
      path: paths.personal,
      source: "personal",
      style: "ultra-simple",
    });
  });

  test("ignores members a later release may add", () => {
    const fixture = repository();
    const environment = { SIMPLE_CHANGES_CONFIG_DIR: temporary("config") };
    writeFileSync(
      join(fixture.root, REPOSITORY_COMMUNICATION_FILENAME),
      sidecar("ultra-simple", { later: { anything: true } })
    );
    expect(resolveCommunication(fixture.root, { environment })).toMatchObject({
      errors: [],
      source: "repository",
      style: "ultra-simple",
    });
  });
});

describe("communication sidecar writes", () => {
  test("writes exactly the two members, and nothing when the style is already saved", () => {
    const directory = temporary("write");
    const path = join(directory, "nested", "communication.json");
    expect(writeCommunication(path, "ultra-simple", true)).toEqual({
      changed: true,
      path,
    });
    expect(readFileSync(path, "utf8")).toBe(sidecar("ultra-simple"));
    // biome-ignore lint/suspicious/noBitwiseOperators: masks the permission bits of a file mode.
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(writeCommunication(path, "ultra-simple", true)).toEqual({
      changed: false,
      path,
    });
    expect(writeCommunication(path, "standard", true).changed).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(sidecar("standard"));
    expect(readdirSync(join(directory, "nested"))).toEqual([
      "communication.json",
    ]);
  });

  test("never replaces a file it cannot read or that is not a regular file", () => {
    const directory = temporary("refuse");
    const path = join(directory, "communication.json");
    writeFileSync(path, "{ not json");
    expect(() => writeCommunication(path, "ultra-simple", false)).toThrow(
      "repair or remove it"
    );
    expect(readFileSync(path, "utf8")).toBe("{ not json");

    const target = join(directory, "elsewhere.json");
    writeFileSync(target, sidecar("standard"));
    rmSync(path);
    symlinkSync(target, path);
    expect(() => writeCommunication(path, "ultra-simple", false)).toThrow(
      "is not a regular file"
    );
    expect(readFileSync(target, "utf8")).toBe(sidecar("standard"));

    // A dangling link is refused too, and stays a link.
    rmSync(target);
    expect(() => writeCommunication(path, "ultra-simple", false)).toThrow(
      "is not a regular file"
    );
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(false);
  });
});

describe("setup --communication and initialize", () => {
  const AUTHORITY_FIELDS = [
    "gitPushAuthorization",
    "migrationHandling",
    "migrationTargets",
    "mutationAllowed",
    "onboardingRequired",
    "policyPath",
    "policySource",
    "policyTrust",
    "productionDeploy",
  ] as const;

  test("turning the mode on changes no policy, trust receipt, or authority", () => {
    const fixture = repository();
    const env = { SIMPLE_CHANGES_CONFIG_DIR: temporary("config") };
    // A saved policy that really holds consequential authority, with the
    // private trust receipt that makes it effective.
    writeFileSync(
      join(fixture.root, ".simple-changes.json"),
      `${JSON.stringify(
        {
          ...DEFAULT_POLICY,
          defaultFinish: "ship",
          migrationHandling: "auto-apply-reviewed-routine",
          migrationTargets: [
            {
              environment: "production",
              project: "storefront",
              provider: "supabase",
            },
          ],
          productionDeploy: "allow",
        },
        null,
        2
      )}\n`
    );
    writeRepositoryPolicyTrustReceipt(
      fixture.root,
      resolve(fixture.root, ".git"),
      "test-user",
      "Authorize this exact test policy"
    );
    const policyPath = join(fixture.root, ".simple-changes.json");
    const trustPath = resolve(
      fixture.root,
      git(fixture.root, ["rev-parse", "--git-common-dir"]),
      "simple-changes",
      "policy-trust.json"
    );
    const initialize = (): Record<string, unknown> => {
      const run = runCli(
        ["initialize", "--mode", "ship", "--repo", fixture.root, "--json"],
        env
      );
      expect(run.stderr).toBe("");
      return JSON.parse(run.stdout) as Record<string, unknown>;
    };
    const authority = (status: Record<string, unknown>) =>
      Object.fromEntries(AUTHORITY_FIELDS.map((key) => [key, status[key]]));
    const policyBefore = readFileSync(policyPath);
    const trustBefore = readFileSync(trustPath);
    const before = initialize();
    expect(before.communication).toEqual({
      errors: [],
      path: null,
      source: "default",
      style: "standard",
    });
    // The comparison below is over real, trusted authority.
    expect(authority(before)).toMatchObject({
      migrationHandling: "auto-apply-reviewed-routine",
      policyTrust: "trusted",
      productionDeploy: "allow",
    });

    const on = runCli(
      [
        "setup",
        "--communication",
        "ultra-simple",
        "--scope",
        "repository",
        "--confirm",
        "--json",
        "--repo",
        fixture.root,
      ],
      env
    );
    expect(on.stderr).toBe("");
    const sidecarPath = join(fixture.root, REPOSITORY_COMMUNICATION_FILENAME);
    expect(JSON.parse(on.stdout)).toMatchObject({
      communication: {
        path: sidecarPath,
        scope: "repository",
        style: "ultra-simple",
        written: true,
      },
    });
    expect(readFileSync(sidecarPath, "utf8")).toBe(sidecar("ultra-simple"));

    const after = initialize();
    expect(after.communication).toEqual({
      errors: [],
      path: sidecarPath,
      source: "repository",
      style: "ultra-simple",
    });
    expect(authority(after)).toEqual(authority(before));
    expect(readFileSync(policyPath).equals(policyBefore)).toBe(true);
    expect(readFileSync(trustPath).equals(trustBefore)).toBe(true);
    // The sidecar is the only path the command created or changed.
    expect(git(fixture.root, ["status", "--porcelain"]).split("\n")).toEqual([
      "?? .simple-changes-communication.json",
      "?? .simple-changes.json",
    ]);

    const again = runCli(
      [
        "setup",
        "--communication",
        "ultra-simple",
        "--scope",
        "repository",
        "--confirm",
        "--json",
        "--repo",
        fixture.root,
      ],
      env
    );
    expect(JSON.parse(again.stdout)).toMatchObject({
      communication: { written: false },
    });
  });

  test("turning the mode on never creates the trust receipt a consequential policy lacks", () => {
    const fixture = repository();
    const env = { SIMPLE_CHANGES_CONFIG_DIR: temporary("config") };
    // The same consequential policy, committed by someone else: this person
    // never confirmed it, so no trust receipt exists here.
    writeFileSync(
      join(fixture.root, ".simple-changes.json"),
      `${JSON.stringify(
        {
          ...DEFAULT_POLICY,
          defaultFinish: "ship",
          migrationHandling: "auto-apply-reviewed-routine",
          migrationTargets: [
            {
              environment: "production",
              project: "storefront",
              provider: "supabase",
            },
          ],
          productionDeploy: "allow",
        },
        null,
        2
      )}\n`
    );
    const trustPath = resolve(
      fixture.root,
      git(fixture.root, ["rev-parse", "--git-common-dir"]),
      "simple-changes",
      "policy-trust.json"
    );
    const reduced = {
      migrationHandling: "ask-after-review",
      policyTrust: "untrusted",
      productionDeploy: "ask",
    };
    const initialize = (): Record<string, unknown> =>
      JSON.parse(
        runCli(
          ["initialize", "--mode", "ship", "--repo", fixture.root, "--json"],
          env
        ).stdout
      ) as Record<string, unknown>;
    expect(initialize()).toMatchObject(reduced);
    expect(existsSync(trustPath)).toBe(false);

    for (const style of ["ultra-simple", "standard", "ultra-simple"]) {
      const set = runCli(
        [
          "setup",
          "--communication",
          style,
          "--scope",
          "repository",
          "--confirm",
          "--repo",
          fixture.root,
        ],
        env
      );
      expect(set.stderr).toBe("");
      expect(set.exitCode).toBe(0);
      expect(existsSync(trustPath)).toBe(false);
      expect(initialize()).toMatchObject({
        ...reduced,
        communication: { source: "repository", style },
      });
    }
  });

  test("a personal setting applies in every project and outranks the project's", () => {
    const fixture = repository();
    const config = temporary("config");
    const env = { SIMPLE_CHANGES_CONFIG_DIR: config };
    const set = (style: string, scope: string) =>
      runCli(
        [
          "setup",
          "--communication",
          style,
          "--scope",
          scope,
          "--confirm",
          "--json",
          "--repo",
          fixture.root,
        ],
        env
      );
    expect(set("ultra-simple", "repository").exitCode).toBe(0);
    const personal = set("standard", "personal");
    expect(personal.stderr).toBe("");
    const personalPath = join(config, "simple-changes", "communication.json");
    expect(JSON.parse(personal.stdout)).toMatchObject({
      communication: { path: personalPath, scope: "personal", written: true },
    });
    const status = JSON.parse(
      runCli(
        ["initialize", "--mode", "queue", "--repo", fixture.root, "--json"],
        env
      ).stdout
    ) as { communication: unknown };
    expect(status.communication).toEqual({
      errors: [],
      path: personalPath,
      source: "personal",
      style: "standard",
    });

    // Saving the project's default says what was saved, and that this
    // person's own setting still decides what they get.
    const repeated = set("ultra-simple", "repository");
    const output = JSON.parse(repeated.stdout) as {
      communication: { effective: unknown; style: string; written: boolean };
      summary: string;
    };
    expect(output.communication).toMatchObject({
      effective: { path: personalPath, source: "personal", style: "standard" },
      style: "ultra-simple",
      written: false,
    });
    expect(output.summary).toContain(
      "Ultra-Simple Mode is on for this project by default"
    );
    expect(output.summary).toContain(
      `For you it stays off: ${personalPath} outranks it.`
    );
  });

  test("refuses anything but one confirmed, saved style", () => {
    const fixture = repository();
    const env = { SIMPLE_CHANGES_CONFIG_DIR: temporary("config") };
    const run = (...args: string[]) =>
      runCli(["setup", ...args, "--repo", fixture.root], env);
    const cases: [string[], string][] = [
      [
        ["--communication", "loud", "--scope", "repository", "--confirm"],
        "--communication must be ultra-simple or standard",
      ],
      [
        ["--communication", "ultra-simple", "--scope", "repository"],
        "requires --confirm",
      ],
      [
        ["--communication", "ultra-simple", "--confirm"],
        "--scope repository or --scope personal",
      ],
      [
        ["--communication", "ultra-simple", "--scope", "run", "--confirm"],
        "--scope repository or --scope personal",
      ],
      [
        [
          "--communication",
          "ultra-simple",
          "--scope",
          "repository",
          "--confirm",
          "--production",
          "allow",
        ],
        "standalone transaction that changes no other setting",
      ],
      [
        [
          "--communication",
          "ultra-simple",
          "--scope",
          "repository",
          "--confirm",
          "--migration-target",
          "supabase:storefront:production",
        ],
        "standalone transaction that changes no other setting",
      ],
      [
        [
          "--communication",
          "ultra-simple",
          "--scope",
          "repository",
          "--confirm",
          "--authoring",
          "{}",
        ],
        "standalone transaction that changes no other setting",
      ],
    ];
    for (const [args, message] of cases) {
      const refused = run(...args);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain(message);
    }
    expect(
      existsSync(join(fixture.root, REPOSITORY_COMMUNICATION_FILENAME))
    ).toBe(false);
    expect(existsSync(join(fixture.root, ".simple-changes.json"))).toBe(false);
  });
});

describe("Use this setup, as two existing commands", () => {
  // The exact commands references/ultra-simple-mode.md gives for the first
  // screen's "Use this setup": the recommended setup with its answers
  // fixed, then the style. No command of its own exists for it.
  const useThisSetup = (
    fixture: TestRepository,
    env: Record<string, string>,
    finish: string
  ) => ({
    setup: runCli(
      [
        "setup",
        "--finish",
        finish,
        "--questions",
        "blocking-only",
        "--scope",
        "repository",
        "--git-push-authorization",
        "ask",
        "--production",
        "ask",
        "--shipping-mode",
        "standard",
        "--migration-handling",
        "ask-after-review",
        "--changelog",
        "preserve-and-report",
        "--instruction-pointer",
        "leave",
        "--yes",
        "--json",
        "--repo",
        fixture.root,
      ],
      env
    ),
    style: runCli(
      [
        "setup",
        "--communication",
        "ultra-simple",
        "--scope",
        "repository",
        "--confirm",
        "--json",
        "--repo",
        fixture.root,
      ],
      env
    ),
  });

  test("saves exactly what the plain receipt promises, for every finish", () => {
    for (const [finish, saved] of [
      ["review", "open-change-request"],
      ["integrate", "integrate"],
      ["ship", "ship"],
    ] as const) {
      const fixture = repository();
      // No changelog provider, whatever this machine has installed.
      const env = {
        SIMPLE_CHANGES_CONFIG_DIR: temporary("config"),
        SIMPLE_CHANGES_SKILL_ROOTS: "",
      };
      const { setup, style } = useThisSetup(fixture, env, finish);
      expect(setup.stderr).toBe("");
      expect(style.stderr).toBe("");
      // Nothing here can go live or touch a database without a question.
      expect(
        (JSON.parse(setup.stdout) as { policy: unknown }).policy
      ).toMatchObject({
        defaultFinish: saved,
        gitPushAuthorization: "ask",
        migrationHandling: "ask-after-review",
        migrationTargets: [],
        productionDeploy: "ask",
        questions: "blocking-only",
        shippingMode: "standard",
      });
      const status = JSON.parse(
        runCli(
          ["initialize", "--mode", "queue", "--repo", fixture.root, "--json"],
          env
        ).stdout
      ) as Record<string, unknown>;
      expect(status).toMatchObject({
        communication: { source: "repository", style: "ultra-simple" },
        onboardingRequired: false,
        policySource: "repository",
        productionDeploy: "ask",
      });
      expect(git(fixture.root, ["status", "--porcelain"]).split("\n")).toEqual([
        "?? .simple-changes-communication.json",
        "?? .simple-changes.json",
      ]);
    }
  });

  test("no quick-start command exists to run over a saved setup", () => {
    const fixture = repository();
    const env = { SIMPLE_CHANGES_CONFIG_DIR: temporary("config") };
    const refused = runCli(
      ["setup", "--quick-start", "--yes", "--repo", fixture.root],
      env
    );
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain("Unknown option: --quick-start");
    expect(existsSync(join(fixture.root, ".simple-changes.json"))).toBe(false);
  });
});

describe("destination checks for a setup that also saves the style", () => {
  test("a dangling policy link counts as a saved policy", () => {
    const directory = temporary("policy");
    const path = join(directory, ".simple-changes.json");
    expect(policyEntryExists(path)).toBe(false);
    symlinkSync(join(directory, "missing.json"), path);
    // existsSync follows the link and reports nothing there.
    expect(existsSync(path)).toBe(false);
    expect(policyEntryExists(path)).toBe(true);
    rmSync(path);
    writeFileSync(path, "{}\n");
    expect(policyEntryExists(path)).toBe(true);
  });

  test("an unusable style file is refused before anything is written", () => {
    const directory = temporary("precheck");
    const path = join(directory, "communication.json");
    expect(() => assertCommunicationWritable(path)).not.toThrow();
    writeFileSync(path, sidecar("standard"));
    expect(() => assertCommunicationWritable(path)).not.toThrow();
    writeFileSync(path, "{ not json");
    expect(() => assertCommunicationWritable(path)).toThrow(
      "repair or remove it"
    );
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });
});

describe("the style is display only", () => {
  test("no rule reads the communication style to decide what is allowed", () => {
    // Only setup's first screen writes it and `initialize` reports it. Any
    // other module importing it would let a display preference steer what
    // Simple Changes may do.
    const importers = readdirSync(libraryDirectory)
      .filter((name) => name.endsWith(".ts") && name !== "communication.ts")
      .filter((name) =>
        readFileSync(join(libraryDirectory, name), "utf8").includes(
          '"./communication.ts"'
        )
      )
      .sort();
    expect(importers).toEqual(["initialization.ts", "onboarding.ts"]);
    const initialization = readFileSync(
      join(libraryDirectory, "initialization.ts"),
      "utf8"
    );
    expect(initialization).toContain(
      'import type { CommunicationReport } from "./communication.ts";'
    );
  });
});
