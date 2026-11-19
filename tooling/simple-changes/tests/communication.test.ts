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
  assertCommunicationUnsetOrSame,
  CHANGELOGS_REPOSITORY_COMMUNICATION_FILENAME,
  communicationPaths,
  REPOSITORY_COMMUNICATION_FILENAME,
  resolveCommunication,
  writeCommunication,
} from "../../../skills/simple-changes/scripts/lib/communication.ts";
import { installWithoutReplacing } from "../../../skills/simple-changes/scripts/lib/path-safety.ts";
import {
  DEFAULT_POLICY,
  policyEntryExists,
  resolvePersonalPolicyPath,
  writePolicyFile,
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

  test("never rewrites a file a newer copy extended", () => {
    const directory = temporary("members");
    const path = join(directory, "communication.json");
    // A number this runtime cannot hold exactly: parsing and writing it back
    // would change it, so the file is left to the copy that knows it.
    const extended =
      '{ "schemaVersion": 1, "style": "ultra-simple", "lastId": 9007199254740993 }\n';
    writeFileSync(path, extended);
    expect(() => writeCommunication(path, "standard", false)).toThrow(
      "holds settings this version cannot safely rewrite (lastId), so it was left as it is"
    );
    expect(readFileSync(path, "utf8")).toBe(extended);
    // Saving the style it already has still changes nothing.
    expect(writeCommunication(path, "ultra-simple", false).changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(extended);
    expect(readdirSync(directory)).toEqual(["communication.json"]);
  });

  test("installs a new file only where nothing is, a dangling link included", () => {
    const directory = temporary("install");
    const staged = join(directory, "staged");
    const path = join(directory, "communication.json");
    writeFileSync(staged, sidecar("ultra-simple"));
    expect(installWithoutReplacing(staged, path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(sidecar("ultra-simple"));
    // Installed means saved: the staged name is gone with it.
    expect(existsSync(staged)).toBe(false);

    // Someone else's file is never replaced, and the staged one is left for
    // the caller to remove.
    writeFileSync(staged, sidecar("standard"));
    expect(installWithoutReplacing(staged, path)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(sidecar("ultra-simple"));
    expect(existsSync(staged)).toBe(true);

    rmSync(path);
    symlinkSync(join(directory, "missing.json"), path);
    expect(installWithoutReplacing(staged, path)).toBe(false);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(existsSync(join(directory, "missing.json"))).toBe(false);
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
      [
        [
          "--communication",
          "ultra-simple",
          "--scope",
          "repository",
          "--confirm",
          "--ui-artifacts",
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
          "--acknowledge-push-scope",
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
          "--dry-run",
        ],
        "has no --dry-run",
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

describe("setup --first-use", () => {
  // The exact command references/ultra-simple-mode.md gives for "Use this
  // setup": the recommended setup with its answers fixed and the style, in
  // one save that happens only when nothing is saved yet.
  const firstUseArgs = (
    root: string,
    finish = "review",
    scope = "repository"
  ): string[] => [
    "setup",
    "--first-use",
    "--communication",
    "ultra-simple",
    "--finish",
    finish,
    "--questions",
    "blocking-only",
    "--scope",
    scope,
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
    root,
  ];
  // No changelog provider, whatever this machine has installed.
  const environment = (): Record<string, string> => ({
    SIMPLE_CHANGES_CONFIG_DIR: temporary("config"),
    SIMPLE_CHANGES_SKILL_ROOTS: "",
  });
  const without = (args: string[], ...flags: string[]): string[] =>
    args.filter((argument) => !flags.includes(argument));
  const paths = (root: string, env: Record<string, string>) => ({
    personalPolicy: resolvePersonalPolicyPath({ environment: env }),
    personalStyle: communicationPaths(null, { environment: env }).personal,
    policy: join(root, ".simple-changes.json"),
    style: join(root, REPOSITORY_COMMUNICATION_FILENAME),
  });

  test("saves exactly what the plain receipt promises, in one command, for every finish", () => {
    for (const [finish, saved] of [
      ["review", "open-change-request"],
      ["integrate", "integrate"],
      ["ship", "ship"],
    ] as const) {
      const fixture = repository();
      const env = environment();
      const setup = runCli(firstUseArgs(fixture.root, finish), env);
      expect(setup.stderr).toBe("");
      const output = JSON.parse(setup.stdout) as Record<string, unknown>;
      // Nothing here can go live or touch a database without a question.
      expect(output.policy).toMatchObject({
        defaultFinish: saved,
        gitPushAuthorization: "ask",
        migrationHandling: "ask-after-review",
        migrationTargets: [],
        productionDeploy: "ask",
        questions: "blocking-only",
        shippingMode: "standard",
      });
      const { style } = paths(fixture.root, env);
      expect(output).toMatchObject({
        authoring: null,
        communication: {
          effective: { path: style, source: "repository" },
          path: style,
          scope: "repository",
          style: "ultra-simple",
          written: true,
        },
        written: true,
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
      // Two files, and no review settings file the receipt does not name.
      expect(git(fixture.root, ["status", "--porcelain"]).split("\n")).toEqual([
        "?? .simple-changes-communication.json",
        "?? .simple-changes.json",
      ]);
    }
  });

  test("writes nothing when a setup is already saved at either layer", () => {
    for (const layer of ["repository", "personal"] as const) {
      const fixture = repository();
      const env = environment();
      const { personalPolicy, policy, style } = paths(fixture.root, env);
      // Someone finished a different setup first: never push.
      const existing = layer === "repository" ? policy : personalPolicy;
      mkdirSync(resolve(existing, ".."), { recursive: true });
      writePolicyFile(existing, {
        ...DEFAULT_POLICY,
        gitPushAuthorization: "never",
      });
      const before = readFileSync(existing);
      const refused = runCli(firstUseArgs(fixture.root), env);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain(
        `A setup is already saved at ${existing}`
      );
      expect(readFileSync(existing).equals(before)).toBe(true);
      expect(existsSync(style)).toBe(false);
      expect(existsSync(policy)).toBe(layer === "repository");
    }
  });

  test("a dangling policy link is a saved setup, and stays a link", () => {
    const fixture = repository();
    const env = environment();
    const { policy, style } = paths(fixture.root, env);
    symlinkSync(join(fixture.root, "missing.json"), policy);
    const refused = runCli(firstUseArgs(fixture.root), env);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain(`A setup is already saved at ${policy}`);
    expect(lstatSync(policy).isSymbolicLink()).toBe(true);
    expect(existsSync(style)).toBe(false);
  });

  test("never changes a style someone saved, and saves nothing beside it", () => {
    const cases: [string, (p: ReturnType<typeof paths>) => string, string][] = [
      // The project chose the standard voice.
      ["standard", (p) => p.style, "already sets the standard style"],
      // This person chose it for themselves; it would outrank the promise.
      ["standard", (p) => p.personalStyle, "keeps the standard wording"],
      ["{ not json", (p) => p.style, "repair or remove it"],
    ];
    for (const [content, target, message] of cases) {
      const fixture = repository();
      const env = environment();
      const all = paths(fixture.root, env);
      const path = target(all);
      const text = content === "standard" ? sidecar("standard") : content;
      mkdirSync(resolve(path, ".."), { recursive: true });
      writeFileSync(path, text);
      const refused = runCli(firstUseArgs(fixture.root), env);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain(message);
      expect(readFileSync(path, "utf8")).toBe(text);
      // The setup itself was not saved either: nothing is half done.
      expect(existsSync(all.policy)).toBe(false);
      expect(existsSync(all.personalPolicy)).toBe(false);
    }
  });

  test("finds the same style already saved and leaves that file alone", () => {
    const fixture = repository();
    const env = environment();
    const { policy, style } = paths(fixture.root, env);
    const committed = sidecar("ultra-simple", { later: true });
    writeFileSync(style, committed);
    const setup = runCli(firstUseArgs(fixture.root), env);
    expect(setup.stderr).toBe("");
    expect(JSON.parse(setup.stdout)).toMatchObject({
      communication: { path: style, written: false },
      written: true,
    });
    expect(readFileSync(style, "utf8")).toBe(committed);
    expect(existsSync(policy)).toBe(true);
  });

  test("guards a first setup that saves no style", () => {
    const fixture = repository();
    const env = environment();
    const { policy, style } = paths(fixture.root, env);
    const args = without(
      firstUseArgs(fixture.root),
      "--communication",
      "ultra-simple"
    );
    const setup = runCli(args, env);
    expect(setup.stderr).toBe("");
    expect(JSON.parse(setup.stdout)).toMatchObject({
      communication: null,
      written: true,
    });
    expect(existsSync(style)).toBe(false);
    const again = runCli(args, env);
    expect(again.exitCode).not.toBe(0);
    expect(again.stderr).toContain(`A setup is already saved at ${policy}`);
  });

  test("saves for the person, outside a repository or in one", () => {
    const outside = temporary("outside");
    for (const root of [outside, repository().root]) {
      const env = environment();
      const { personalPolicy, personalStyle, policy, style } = paths(root, env);
      const setup = runCli(firstUseArgs(root, "review", "personal"), env);
      expect(setup.stderr).toBe("");
      expect(JSON.parse(setup.stdout)).toMatchObject({
        communication: {
          path: personalStyle,
          scope: "personal",
          written: true,
        },
        path: personalPolicy,
      });
      expect(readFileSync(personalStyle, "utf8")).toBe(sidecar("ultra-simple"));
      expect(existsSync(policy)).toBe(false);
      expect(existsSync(style)).toBe(false);
    }
    const refused = runCli(firstUseArgs(outside), environment());
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("use --scope personal outside one");
  });

  test("asks nothing and refuses what it cannot save in one step", () => {
    const fixture = repository();
    const env = environment();
    const all = paths(fixture.root, env);
    const args = firstUseArgs(fixture.root);
    const cases: [string[], string][] = [
      [without(args, "--yes"), "requires --yes"],
      [[...args, "--dry-run"], "has no --dry-run"],
      [[...args, "--authoring", "{}"], "never the review settings"],
      [
        args.map((argument) => (argument === "repository" ? "run" : argument)),
        "--scope repository or --scope personal",
      ],
      // A missing answer is never asked for, in a terminal or out of one.
      [without(args, "--questions", "blocking-only"), "asks nothing"],
    ];
    for (const [invocation, message] of cases) {
      const refused = runCli(invocation, env);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain(message);
    }
    for (const path of Object.values(all)) {
      expect(existsSync(path)).toBe(false);
    }
    expect(git(fixture.root, ["status", "--porcelain"])).toBe("");
  });
});

describe("destination checks for a first-use save", () => {
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

  test("a create-only policy write never replaces a setup saved meanwhile", () => {
    const directory = temporary("create-only");
    const path = join(directory, "nested", ".simple-changes.json");
    writePolicyFile(path, DEFAULT_POLICY, false, true);
    const first = readFileSync(path);
    // The other setup won the race: this one reports it and keeps its file.
    expect(() =>
      writePolicyFile(
        path,
        { ...DEFAULT_POLICY, gitPushAuthorization: "never" },
        false,
        true
      )
    ).toThrow("while this one was open, so it was not replaced");
    expect(readFileSync(path).equals(first)).toBe(true);
    expect(readdirSync(join(directory, "nested"))).toEqual([
      ".simple-changes.json",
    ]);
  });

  test("a style is created or found the same, never changed or guessed at", () => {
    const directory = temporary("precheck");
    const path = join(directory, "communication.json");
    expect(() =>
      assertCommunicationUnsetOrSame(path, "ultra-simple")
    ).not.toThrow();
    writeFileSync(path, sidecar("ultra-simple"));
    expect(() =>
      assertCommunicationUnsetOrSame(path, "ultra-simple")
    ).not.toThrow();
    writeFileSync(path, sidecar("standard"));
    expect(() => assertCommunicationUnsetOrSame(path, "ultra-simple")).toThrow(
      "already sets the standard style"
    );
    writeFileSync(path, "{ not json");
    expect(() => assertCommunicationUnsetOrSame(path, "ultra-simple")).toThrow(
      "repair or remove it"
    );
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });
});

describe("the style is display only", () => {
  test("no rule reads the communication style to decide what is allowed", () => {
    // Only `setup` writes it, from the command itself, and `initialize`
    // reports it. Any other module importing it would let a display
    // preference steer what Simple Changes may do.
    const importers = readdirSync(libraryDirectory)
      .filter((name) => name.endsWith(".ts") && name !== "communication.ts")
      .filter((name) =>
        readFileSync(join(libraryDirectory, name), "utf8").includes(
          '"./communication.ts"'
        )
      )
      .sort();
    expect(importers).toEqual(["initialization.ts"]);
    const initialization = readFileSync(
      join(libraryDirectory, "initialization.ts"),
      "utf8"
    );
    expect(initialization).toContain(
      'import type { CommunicationReport } from "./communication.ts";'
    );
  });
});
