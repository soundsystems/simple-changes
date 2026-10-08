import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "bun";
import {
  type AuthoringFileState,
  type AuthoringSidecar,
  authoringPaths,
  authoringQuestionState,
  changelogsHarnessPrefill,
  changelogsPersonalAuthoringPath,
  detectHarnesses,
  type HarnessDefinition,
  loadHarnessDefinitions,
  readAuthoringFile,
  resolveAuthoringRole,
  resolveRepositoryAuthoring,
  validateAuthoringSidecar,
  writeAuthoringSidecar,
} from "../../../skills/simple-changes/scripts/lib/authoring.ts";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import { resolveReviewer } from "../../../skills/simple-changes/scripts/lib/review-ledger.ts";
import { createTestRepository, git, type TestRepository } from "./helpers.ts";

// Authoring preferences (design sections 2, 3, 5.1.4 and 6.3) for Simple
// Changes: the sidecar validator, detection, resolution with provenance, the
// per-question truth table, the standalone writer, and the initialize fields.
// Detection uses neutral fixture ids so the test machine never matters.

setDefaultTimeout(60_000);
const repositoryRoot = resolve(import.meta.dir, "../../..");
const cliPath = resolve(
  repositoryRoot,
  "skills/simple-changes/scripts/simple-changes.ts"
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
  const path = realpathSync(mkdtempSync(join(tmpdir(), `authoring-${label}-`)));
  scratch.push(path);
  return path;
};

const DEFINITIONS: HarnessDefinition[] = [
  {
    homeRoots: [".alpha"],
    id: "alpha-agent",
    name: "Alpha Agent",
    sessionEnv: ["ALPHA_SESSION_ID"],
  },
  {
    homeRoots: [".beta"],
    id: "beta-agent",
    name: "Beta Agent",
    sessionEnv: ["BETA_THREAD_ID"],
  },
  { homeRoots: [".gamma"], id: "gamma", name: "Gamma", sessionEnv: [] },
];

const dataFile = (): string => {
  const path = join(temporary("data"), "harnesses.json");
  writeFileSync(
    path,
    `${JSON.stringify({
      harnesses: Object.fromEntries(
        DEFINITIONS.map(({ id, ...rest }) => [id, rest])
      ),
      schemaVersion: 1,
    })}\n`
  );
  return path;
};

const AUTHORING_FIELD = /authoring|reviewLedger|review-ledger|harnesses/u;
const EMPTY: AuthoringSidecar = { harnesses: {}, roles: {}, schemaVersion: 1 };

const sidecar = (
  harnesses: AuthoringSidecar["harnesses"],
  roles: AuthoringSidecar["roles"] = {}
): AuthoringSidecar => ({ harnesses, roles, schemaVersion: 1 });

// Untyped on purpose: the table holds invalid sidecars too.
const loose = (
  harnesses: Record<string, unknown>,
  roles: Record<string, unknown> = {}
): Record<string, unknown> => ({ harnesses, roles, schemaVersion: 1 });

const VALIDATION_TABLE: { name: string; valid: boolean; value: unknown }[] = [
  { name: "empty", valid: true, value: EMPTY },
  {
    name: "cross-harness review",
    valid: true,
    value: loose(
      { "alpha-agent": { effort: "xhigh", model: "most-capable" } },
      {
        proposals: { harness: "running" },
        review: {
          adversarial: true,
          escalateOnFindings: "xhigh",
          harness: "beta-agent",
        },
      }
    ),
  },
  {
    name: "same harness, different model",
    valid: true,
    value: loose(
      { "alpha-agent": { model: "author-model" } },
      {
        review: {
          adversarial: true,
          effort: "max",
          harness: "alpha-agent",
          model: "review-model",
        },
      }
    ),
  },
  {
    name: "unknown valid id and a null entry",
    valid: true,
    value: loose({ gamma: null, "house-agent-9": { model: "x" } }),
  },
  {
    name: "escalation null",
    valid: true,
    value: loose(
      {},
      { review: { escalateOnFindings: null, harness: "running" } }
    ),
  },
  {
    name: "role-level model with running",
    valid: false,
    value: loose({}, { review: { harness: "running", model: "x" } }),
  },
  {
    name: "escalation to max",
    valid: false,
    value: loose(
      {},
      { review: { escalateOnFindings: "max", harness: "gamma" } }
    ),
  },
  {
    name: "adversarial on proposals",
    valid: false,
    value: loose({}, { proposals: { adversarial: true, harness: "running" } }),
  },
  {
    name: "a Simple Changelogs role",
    valid: false,
    value: loose({}, { "release-notes": { harness: "running" } }),
  },
  {
    name: "invalid id key",
    valid: false,
    value: loose({ "Upper Case": { model: "x" } }),
  },
  {
    name: "nested unknown key",
    valid: false,
    value: loose({ gamma: { command: "x", model: "y" } }),
  },
  {
    name: "model with a control character",
    valid: false,
    value: loose({ gamma: { model: "a\u0007b" } }),
  },
  {
    name: "unknown effort",
    valid: false,
    value: loose({ gamma: { effort: "turbo", model: "y" } }),
  },
  {
    name: "a harness id spelled like an inherited property",
    valid: true,
    value: loose({ constructor: { model: "x" } }),
  },
  {
    name: "a malformed entry under an inherited property name",
    valid: false,
    value: loose({ constructor: { extra: true, model: 42 } }),
  },
  { name: "unknown top-level key", valid: false, value: { ...EMPTY, x: 1 } },
  {
    name: "schema version 2",
    valid: false,
    value: { ...EMPTY, schemaVersion: 2 },
  },
];

describe("authoring sidecar validation", () => {
  test("accepts and rejects the 6.3 table, and the schema agrees on values", () => {
    for (const { name, valid, value } of VALIDATION_TABLE) {
      expect({
        name,
        valid: validateAuthoringSidecar(value).value !== undefined,
      }).toEqual({
        name,
        valid,
      });
    }
    expect(
      validateAuthoringSidecar(
        loose(
          { gamma: { command: "x", model: "y" } },
          {
            review: { harness: "running", model: "x" },
          }
        )
      ).errors
    ).toEqual([
      'roles.review.model requires a concrete harness id, never "running"',
      "harnesses.gamma.command is not allowed",
    ]);
    // The packaged schema validates values; object keys are the validator's.
    const schemaValid = (value: unknown): boolean => {
      const schema = JSON.parse(
        readFileSync(
          resolve(
            repositoryRoot,
            "skills/simple-changes/evals/schemas/authoring.schema.json"
          ),
          "utf8"
        )
      ) as Record<string, unknown>;
      return schemaAccepts(schema, value);
    };
    for (const { name, valid, value } of VALIDATION_TABLE) {
      expect({ name, valid: schemaValid(value) }).toEqual({ name, valid });
    }
  });
});

// A compact evaluator for the authoring schema's keywords.
const schemaAccepts = (
  root: Record<string, unknown>,
  value: unknown,
  schema: Record<string, unknown> = root
): boolean => {
  const isObject = (candidate: unknown): candidate is Record<string, unknown> =>
    typeof candidate === "object" &&
    candidate !== null &&
    !Array.isArray(candidate);
  if (typeof schema.$ref === "string") {
    const target = schema.$ref
      .slice(2)
      .split("/")
      .reduce<unknown>(
        (node, part) => (isObject(node) ? node[part] : undefined),
        root
      );
    return schemaAccepts(root, value, target as Record<string, unknown>);
  }
  const checks: boolean[] = [];
  if ("const" in schema) {
    checks.push(value === schema.const);
  }
  if (Array.isArray(schema.enum)) {
    checks.push(schema.enum.includes(value));
  }
  if (schema.type === "object") {
    checks.push(isObject(value));
  }
  if (schema.type === "string") {
    checks.push(typeof value === "string");
  }
  if (schema.type === "boolean") {
    checks.push(typeof value === "boolean");
  }
  if (schema.type === "null") {
    checks.push(value === null);
  }
  if (Array.isArray(schema.anyOf)) {
    checks.push(
      schema.anyOf.some((branch) =>
        schemaAccepts(root, value, branch as Record<string, unknown>)
      )
    );
  }
  if (typeof value === "string") {
    const characters = [...value].length;
    if (typeof schema.minLength === "number") {
      checks.push(characters >= schema.minLength);
    }
    if (typeof schema.maxLength === "number") {
      checks.push(characters <= schema.maxLength);
    }
    if (typeof schema.pattern === "string") {
      checks.push(new RegExp(schema.pattern, "u").test(value));
    }
  }
  if (isObject(value)) {
    if (isObject(schema.propertyNames)) {
      for (const key of Object.keys(value)) {
        checks.push(schemaAccepts(root, key, schema.propertyNames));
      }
    }
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      checks.push(Object.hasOwn(value, key));
    }
    for (const [key, item] of Object.entries(value)) {
      const nested = Object.hasOwn(properties, key)
        ? properties[key]
        : schema.additionalProperties;
      if (nested === false) {
        checks.push(false);
      } else if (isObject(nested)) {
        checks.push(schemaAccepts(root, item, nested));
      }
    }
    if (
      isObject(schema.if) &&
      isObject(schema.then) &&
      schemaAccepts(root, value, schema.if)
    ) {
      checks.push(schemaAccepts(root, value, schema.then));
    }
  }
  return checks.every(Boolean);
};

const layer = (name: "personal" | "repository", value: AuthoringSidecar) => ({
  layer: name,
  path: `/${name}/authoring.json`,
  value,
});

describe("authoring resolution", () => {
  test("replaces roles and harness entries whole and reports provenance", () => {
    const personal = layer(
      "personal",
      sidecar(
        {
          "alpha-agent": { effort: "high", model: "personal-alpha" },
          "beta-agent": { model: "personal-beta" },
        },
        {
          review: {
            adversarial: true,
            escalateOnFindings: "xhigh",
            harness: "beta-agent",
          },
        }
      )
    );
    const repository = layer(
      "repository",
      sidecar(
        { "beta-agent": { model: "repo-beta" } },
        {
          proposals: { effort: "medium", harness: "running" },
        }
      )
    );
    const proposals = resolveAuthoringRole(
      "proposals",
      [repository, personal],
      "alpha-agent"
    );
    expect(proposals.effective).toMatchObject({
      effort: "medium",
      harness: "alpha-agent",
      model: "personal-alpha",
      status: "resolved",
    });
    expect(proposals.source).toEqual({
      effort: "repository",
      harness: "repository",
      model: "personal",
      path: "/repository/authoring.json",
    });
    // The repository entry for beta-agent replaces the personal one whole.
    const review = resolveAuthoringRole(
      "review",
      [repository, personal],
      "alpha-agent"
    );
    expect(review.effective).toEqual({
      adversarial: true,
      effort: "xhigh",
      escalateOnFindings: "xhigh",
      harness: "beta-agent",
      model: "repo-beta",
      status: "resolved",
    });
    expect(review.source).toEqual({
      effort: "default",
      harness: "personal",
      model: "repository",
      path: "/repository/authoring.json",
    });
    // The same sidecars read from another running harness.
    expect(
      resolveAuthoringRole("proposals", [repository, personal], "beta-agent")
        .effective
    ).toMatchObject({ harness: "beta-agent", model: "repo-beta" });
    // An empty repository sidecar over a populated personal one defines nothing.
    expect(
      resolveAuthoringRole(
        "review",
        [layer("repository", EMPTY), personal],
        "alpha-agent"
      ).effective
    ).toMatchObject({ harness: "beta-agent", model: "personal-beta" });
  });

  test("a role-level model and effort win over the target's entry", () => {
    expect(
      resolveAuthoringRole(
        "review",
        [
          layer(
            "personal",
            sidecar(
              { "beta-agent": { effort: "low", model: "entry-model" } },
              {
                review: {
                  adversarial: true,
                  effort: "max",
                  harness: "beta-agent",
                  model: "role-model",
                },
              }
            )
          ),
        ],
        "alpha-agent"
      ).effective
    ).toMatchObject({ effort: "max", model: "role-model", status: "resolved" });
  });

  test("handles null entries, unknown ids, and an unknown running harness", () => {
    expect(
      resolveAuthoringRole(
        "review",
        [
          layer(
            "repository",
            sidecar({ gamma: null }, { review: { harness: "gamma" } })
          ),
        ],
        "alpha-agent"
      ).effective
    ).toMatchObject({ harness: "gamma", status: "no-delegation" });
    expect(
      resolveAuthoringRole(
        "review",
        [
          layer(
            "repository",
            sidecar({}, { review: { harness: "house-agent" } })
          ),
        ],
        null
      ).effective
    ).toMatchObject({
      effort: "xhigh",
      harness: "house-agent",
      model: "most-capable",
      status: "most-capable",
    });
    expect(resolveAuthoringRole("proposals", [], null).effective).toMatchObject(
      {
        harness: "unknown",
        status: "unresolved",
      }
    );
  });
});

describe("harness detection", () => {
  test("reports session and home-root evidence, data-file order, and fails closed", () => {
    const roots = temporary("roots");
    mkdirSync(join(roots, ".gamma"));
    mkdirSync(join(roots, ".beta"));
    expect(
      detectHarnesses(DEFINITIONS, {
        environment: {
          BETA_THREAD_ID: "t-1",
          SIMPLE_CHANGES_HARNESS_ROOTS: roots,
        },
      })
    ).toEqual({
      detected: [
        {
          evidence: [
            "running session (BETA_THREAD_ID)",
            `harness root (${join(roots, ".beta")})`,
          ],
          id: "beta-agent",
          name: "Beta Agent",
        },
        {
          evidence: [`harness root (${join(roots, ".gamma")})`],
          id: "gamma",
          name: "Gamma",
        },
      ],
      running: "beta-agent",
    });
    expect(loadHarnessDefinitions().length).toBeGreaterThan(0);
    const broken = join(temporary("broken"), "harnesses.json");
    expect(() => loadHarnessDefinitions(broken)).toThrow(
      "missing or unreadable"
    );
    writeFileSync(
      broken,
      '{"schemaVersion":1,"harnesses":{"x":{"name":"x","homeRoots":["../up"],"sessionEnv":[]}}}'
    );
    expect(() => loadHarnessDefinitions(broken)).toThrow("malformed");
  });
});

const fileState = (
  state: AuthoringFileState["state"],
  value?: AuthoringSidecar
): AuthoringFileState => ({
  errors: state === "malformed" ? ["bad"] : [],
  path: `/${state}.json`,
  state,
  ...(value ? { value } : {}),
});

describe("the 5.1.4 truth table", () => {
  const absent = fileState("absent");
  const valid = (value: AuthoringSidecar = EMPTY) => fileState("valid", value);
  const state = (input: {
    detectedCount: number;
    personal?: AuthoringFileState;
    repository?: AuthoringFileState;
    setupStyle?: "recommended" | "walkthrough" | "customize" | "run";
    writeCapable?: boolean;
  }) =>
    authoringQuestionState({
      detectedCount: input.detectedCount,
      personal: input.personal ?? absent,
      repository: input.repository ?? absent,
      setupStyle: input.setupStyle ?? "recommended",
      writeCapable: input.writeCapable ?? true,
    });

  test("covers every row in every setup style", () => {
    expect(state({ detectedCount: 3, writeCapable: false })).toEqual({
      models: "not-applicable",
      review: "not-applicable",
    });
    expect(
      state({ detectedCount: 2, repository: fileState("malformed") })
    ).toEqual({
      models: "repair",
      review: "repair",
    });
    for (const setupStyle of ["recommended", "run"] as const) {
      expect(state({ detectedCount: 0, setupStyle })).toEqual({
        models: "pending",
        review: "not-applicable",
      });
      expect(state({ detectedCount: 1, setupStyle })).toEqual({
        models: "pending",
        review: "not-applicable",
      });
      expect(
        state({ detectedCount: 1, personal: valid(), setupStyle })
      ).toEqual({
        models: "answered",
        review: "not-applicable",
      });
    }
    for (const setupStyle of ["customize", "walkthrough"] as const) {
      expect(state({ detectedCount: 0, setupStyle })).toEqual({
        models: "pending",
        review: "pending",
      });
      expect(
        state({ detectedCount: 1, repository: valid(), setupStyle })
      ).toEqual({
        models: "answered",
        review: "pending",
      });
    }
    for (const setupStyle of [
      "recommended",
      "run",
      "customize",
      "walkthrough",
    ] as const) {
      expect(state({ detectedCount: 2, setupStyle })).toEqual({
        models: "pending",
        review: "pending",
      });
      expect(
        state({ detectedCount: 2, personal: valid(), setupStyle })
      ).toEqual({
        models: "answered",
        review: "pending",
      });
      // R1 option 3's recorded role answers the review question.
      expect(
        state({
          detectedCount: 2,
          repository: valid(
            sidecar({}, { review: { adversarial: false, harness: "running" } })
          ),
          setupStyle,
        })
      ).toEqual({ models: "answered", review: "answered" });
    }
  });

  test("a second harness detected later makes review pending again", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const roots = temporary("roots");
    const config = temporary("config");
    const environment = {
      SIMPLE_CHANGES_CONFIG_DIR: config,
      SIMPLE_CHANGES_HARNESS_ROOTS: roots,
    };
    mkdirSync(join(roots, ".alpha"));
    const harnessDataPath = dataFile();
    // A single-harness recommended setup records no review role.
    writeAuthoringSidecar(
      authoringPaths(fixture.root, { environment }).repository,
      sidecar(
        { "alpha-agent": { effort: "xhigh", model: "most-capable" } },
        {
          proposals: { harness: "running" },
        }
      ),
      false
    );
    const before = resolveRepositoryAuthoring(fixture.root, {
      environment,
      harnessDataPath,
    });
    expect(before.authoringQuestion).toEqual({
      models: "answered",
      review: "not-applicable",
    });
    mkdirSync(join(roots, ".beta"));
    const after = resolveRepositoryAuthoring(fixture.root, {
      environment,
      harnessDataPath,
    });
    expect(after.detectedHarnesses.map(({ id }) => id)).toEqual([
      "alpha-agent",
      "beta-agent",
    ]);
    expect(after.authoringQuestion).toEqual({
      models: "answered",
      review: "pending",
    });
  });
});

describe("sidecar files", () => {
  test("writes atomically, refuses malformed or symlinked targets, and leaves files on failure", () => {
    const directory = temporary("files");
    const path = join(directory, "authoring.json");
    expect(writeAuthoringSidecar(path, EMPTY, true)).toEqual({
      path,
      written: true,
    });
    expect(writeAuthoringSidecar(path, EMPTY, true)).toEqual({
      path,
      written: false,
    });
    expect(() => writeAuthoringSidecar(path, { ...EMPTY, x: 1 }, true)).toThrow(
      "authoring answer is invalid"
    );
    writeFileSync(path, '{"schemaVersion":1}');
    expect(readAuthoringFile(path).state).toBe("malformed");
    expect(() => writeAuthoringSidecar(path, EMPTY, true)).toThrow(
      "Repair or remove"
    );
    expect(readFileSync(path, "utf8")).toBe('{"schemaVersion":1}');
    rmSync(path);
    const elsewhere = join(directory, "elsewhere.json");
    writeFileSync(elsewhere, `${JSON.stringify(EMPTY)}\n`);
    symlinkSync(elsewhere, path);
    expect(readAuthoringFile(path).state).toBe("malformed");
    rmSync(path);
    const kept = sidecar({ gamma: { model: "kept" } });
    writeAuthoringSidecar(path, kept, true);
    chmodSync(directory, 0o500);
    try {
      expect(() => writeAuthoringSidecar(path, EMPTY, true)).toThrow();
    } finally {
      chmodSync(directory, 0o700);
    }
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(kept);
    expect(
      readdirSync(directory).filter((name) => name.endsWith(".tmp"))
    ).toEqual([]);
  });

  test("resolves the Simple Changelogs personal sidecar with that skill's rules", () => {
    expect(
      changelogsPersonalAuthoringPath({
        environment: { SIMPLE_CHANGELOGS_CONFIG_DIR: "/override" },
        homeDirectory: "/home/u",
        platform: "linux",
      })
    ).toBe("/override/authoring.json");
    expect(
      changelogsPersonalAuthoringPath({
        environment: { SIMPLE_CHANGELOGS_CONFIG_DIR: "/x/simple-changelogs" },
        homeDirectory: "/home/u",
        platform: "linux",
      })
    ).toBe("/x/simple-changelogs/authoring.json");
    expect(
      changelogsPersonalAuthoringPath({
        environment: {},
        homeDirectory: "/Users/u",
        platform: "darwin",
      })
    ).toBe(
      "/Users/u/Library/Application Support/simple-changelogs/authoring.json"
    );
    expect(
      changelogsPersonalAuthoringPath({
        environment: { XDG_CONFIG_HOME: "/xdg" },
        homeDirectory: "/home/u",
        platform: "linux",
      })
    ).toBe("/xdg/simple-changelogs/authoring.json");
    expect(
      changelogsPersonalAuthoringPath({
        environment: {},
        homeDirectory: "/home/u",
        platform: "linux",
      })
    ).toBe("/home/u/.config/simple-changelogs/authoring.json");
    expect(
      changelogsPersonalAuthoringPath({
        environment: { APPDATA: "C:\\\\Roaming" },
        homeDirectory: "C:\\\\Users\\\\u",
        platform: "win32",
      })
    ).toBe(join("C:\\\\Roaming", "simple-changelogs", "authoring.json"));
  });

  test("pre-fills from the repository sidecar, then the personal one, ignoring malformed files", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const config = temporary("changelogs-config");
    const environment = { SIMPLE_CHANGELOGS_CONFIG_DIR: config };
    expect(changelogsHarnessPrefill(fixture.root, { environment })).toBeNull();
    const releaseNotes = (harnesses: AuthoringSidecar["harnesses"]) =>
      `${JSON.stringify({
        harnesses,
        roles: { "release-notes": { harness: "running" } },
        schemaVersion: 1,
      })}\n`;
    writeFileSync(
      join(config, "authoring.json"),
      releaseNotes({ gamma: null })
    );
    expect(changelogsHarnessPrefill(fixture.root, { environment })).toEqual({
      harnesses: ["gamma"],
      path: join(config, "authoring.json"),
    });
    // A CMS-only or any other distribution uses the same repository file.
    writeFileSync(
      join(fixture.root, ".simple-changelogs-authoring.json"),
      releaseNotes({
        "alpha-agent": { model: "most-capable" },
        "beta-agent": null,
      })
    );
    expect(
      changelogsHarnessPrefill(fixture.root, { environment })?.harnesses
    ).toEqual(["alpha-agent", "beta-agent"]);
    // A malformed repository file is treated as absent.
    writeFileSync(
      join(fixture.root, ".simple-changelogs-authoring.json"),
      '{"schemaVersion":1,"roles":{"review":{"harness":"running"}},"harnesses":{}}'
    );
    expect(changelogsHarnessPrefill(fixture.root, { environment })?.path).toBe(
      join(config, "authoring.json")
    );
  });
});

describe("reviewer resolution before dispatch", () => {
  const authoringWith = (value: AuthoringSidecar, running: string | null) => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const environment: Record<string, string> = {
      SIMPLE_CHANGES_CONFIG_DIR: temporary("config"),
      SIMPLE_CHANGES_HARNESS_ROOTS: temporary("roots"),
    };
    if (running === "alpha-agent") {
      environment.ALPHA_SESSION_ID = "s-1";
    }
    writeAuthoringSidecar(
      authoringPaths(fixture.root, { environment }).repository,
      value,
      false
    );
    return {
      authoring: resolveRepositoryAuthoring(fixture.root, {
        environment,
        harnessDataPath: dataFile(),
      }),
      root: fixture.root,
    };
  };

  test("resolves, leaves unresolved, or blocks a provisional adversarial reviewer", () => {
    const crossHarness = authoringWith(
      sidecar(
        { "alpha-agent": { model: "a-1" }, "beta-agent": { model: "b-1" } },
        {
          proposals: { harness: "running" },
          review: { adversarial: true, harness: "beta-agent" },
        }
      ),
      "alpha-agent"
    );
    expect(
      resolveReviewer({
        authoring: crossHarness.authoring,
        repositoryRoot: crossHarness.root,
      })
    ).toMatchObject({
      harness: "beta-agent",
      mode: "provisional",
      model: "b-1",
      status: "resolved",
    });
    const sameModel = authoringWith(
      sidecar(
        { "alpha-agent": { model: "a-1" } },
        {
          review: { adversarial: true, harness: "alpha-agent", model: "a-1" },
        }
      ),
      "alpha-agent"
    );
    expect(
      resolveReviewer({
        authoring: sameModel.authoring,
        repositoryRoot: sameModel.root,
      })
    ).toMatchObject({ reason: "reviewer-not-distinct", status: "blocked" });
    const nullTarget = authoringWith(
      sidecar(
        { "beta-agent": null },
        {
          review: { adversarial: true, harness: "beta-agent" },
        }
      ),
      "alpha-agent"
    );
    expect(
      resolveReviewer({
        authoring: nullTarget.authoring,
        repositoryRoot: nullTarget.root,
      })
    ).toMatchObject({ reason: "reviewer-not-distinct", status: "blocked" });
    const unknownAuthor = authoringWith(
      sidecar({}, { review: { adversarial: true, harness: "beta-agent" } }),
      null
    );
    expect(
      resolveReviewer({
        authoring: unknownAuthor.authoring,
        repositoryRoot: unknownAuthor.root,
      })
    ).toMatchObject({
      reason: "running-harness-unknown",
      status: "unresolved",
    });
    // Under adversarial: false no identity is compared.
    const plain = authoringWith(
      sidecar(
        { "alpha-agent": { model: "a-1" } },
        {
          review: { adversarial: false, harness: "running" },
        }
      ),
      "alpha-agent"
    );
    expect(
      resolveReviewer({
        authoring: plain.authoring,
        repositoryRoot: plain.root,
      })
    ).toMatchObject({
      harness: "alpha-agent",
      model: "a-1",
      status: "resolved",
    });
  });
});

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

describe("setup --authoring and initialize", () => {
  test("records the answer as a standalone transaction and reports it through initialize", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const roots = temporary("roots");
    mkdirSync(join(roots, ".claude"));
    mkdirSync(join(roots, ".codex"));
    const env = {
      SIMPLE_CHANGES_CONFIG_DIR: temporary("config"),
      SIMPLE_CHANGES_HARNESS_ROOTS: roots,
    };
    const initialize = (mode: string, extra: string[] = []) => {
      const run = runCli(
        [
          "initialize",
          "--mode",
          mode,
          "--repo",
          fixture.root,
          "--json",
          ...extra,
        ],
        env
      );
      expect(run.stderr).toBe("");
      return JSON.parse(run.stdout) as Record<string, unknown>;
    };
    const before = initialize("queue");
    expect(before.authoringQuestion).toEqual({
      models: "pending",
      review: "pending",
    });
    expect((before.detectedHarnesses as { id: string }[]).length).toBe(2);
    expect(before.reviewer).toMatchObject({ mode: "provisional" });
    for (const mode of ["preview", "pause", "sync"]) {
      expect(initialize(mode).authoringQuestion).toEqual({
        models: "not-applicable",
        review: "not-applicable",
      });
    }
    const refused = runCli(
      [
        "setup",
        "--authoring",
        JSON.stringify(EMPTY),
        "--scope",
        "run",
        "--confirm",
        "--repo",
        fixture.root,
      ],
      env
    );
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("--scope repository or --scope personal");
    const unconfirmed = runCli(
      [
        "setup",
        "--authoring",
        JSON.stringify(EMPTY),
        "--scope",
        "repository",
        "--repo",
        fixture.root,
      ],
      env
    );
    expect(unconfirmed.stderr).toContain("requires --confirm");
    const answerPath = join(temporary("answer"), "answer.json");
    writeFileSync(
      answerPath,
      JSON.stringify(
        sidecar(
          {
            "claude-code": { model: "most-capable" },
            codex: { model: "most-capable" },
          },
          {
            proposals: { harness: "running" },
            review: { adversarial: false, harness: "running" },
          }
        )
      )
    );
    const recorded = runCli(
      [
        "setup",
        "--authoring",
        `@${answerPath}`,
        "--scope",
        "repository",
        "--confirm",
        "--repo",
        fixture.root,
        "--json",
      ],
      env
    );
    expect(recorded.stderr).toBe("");
    const output = JSON.parse(recorded.stdout) as {
      authoring: { path: string; scope: string; written: boolean };
      authoringQuestion: unknown;
      summary: string;
    };
    expect(output.authoring).toEqual({
      path: join(fixture.root, ".simple-changes-authoring.json"),
      scope: "repository",
      written: true,
    });
    expect(output.summary).toContain("Commit this file with your policy");
    expect(output.summary).toContain("0.28.0 or later");
    expect(output.authoringQuestion).toEqual({
      models: "answered",
      review: "answered",
    });
    expect(existsSync(join(fixture.root, ".simple-changes.json"))).toBe(false);
    const after = initialize("queue", [
      "--proposal",
      "7",
      "--head",
      git(fixture.root, ["rev-parse", "HEAD"]),
    ]);
    expect(after.authoringQuestion).toEqual({
      models: "answered",
      review: "answered",
    });
    // The running harness is unknown in this environment, so the review
    // target cannot be resolved; the verified evidence still validates.
    expect(after.reviewer).toMatchObject({
      mode: "verified",
      proposal: { proposalId: "7" },
      reason: "running-harness-unknown",
      status: "unresolved",
    });
    const identified = runCli(
      [
        "initialize",
        "--mode",
        "queue",
        "--repo",
        fixture.root,
        "--json",
        "--proposal",
        "7",
        "--head",
        git(fixture.root, ["rev-parse", "HEAD"]),
      ],
      { ...env, CLAUDE_CODE_SESSION_ID: "authoring-test-session" }
    );
    expect(JSON.parse(identified.stdout).reviewer).toMatchObject({
      mode: "verified",
      reason: "authors-not-recorded",
      status: "unresolved",
    });
    const halfVerified = runCli(
      [
        "initialize",
        "--mode",
        "queue",
        "--repo",
        fixture.root,
        "--proposal",
        "!7",
      ],
      env
    );
    expect(halfVerified.exitCode).not.toBe(0);
    expect(halfVerified.stderr).toContain(
      "--proposal and --head must be given together"
    );
  });
});

describe("older copies", () => {
  test("closed policy, lease, and run-state schemas gain no authoring or ledger field", () => {
    const schemaText = (name: string): string =>
      readFileSync(
        resolve(
          repositoryRoot,
          `skills/simple-changes/evals/schemas/${name}.schema.json`
        ),
        "utf8"
      );
    for (const name of [
      "repo-policy",
      "loop-lease",
      "run-state",
      "worktree-coordination",
    ]) {
      const text = schemaText(name);
      expect({
        mentions: AUTHORING_FIELD.test(text),
        name,
      }).toEqual({
        mentions: false,
        name,
      });
    }
  });

  test("a repository with a sidecar and a ledger still loads its policy and inventory unchanged", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const policy = `${JSON.stringify({
      concurrentWork: "allow-claimed",
      defaultFinish: "open-change-request",
      guidance: { version: 1 },
      productionDeploy: "ask",
      questions: "blocking-only",
      review: "repository-policy",
      schemaVersion: 1,
    })}\n`;
    writeFileSync(join(fixture.root, ".simple-changes.json"), policy);
    writeFileSync(
      join(fixture.root, ".simple-changes-authoring.json"),
      `${JSON.stringify(EMPTY)}\n`
    );
    git(fixture.root, ["add", "."]);
    git(fixture.root, ["commit", "-m", "Policy and authoring"]);
    const ledgerDirectory = join(fixture.root, ".git", "simple-changes");
    mkdirSync(ledgerDirectory, { recursive: true });
    writeFileSync(
      join(ledgerDirectory, "review-ledger.json"),
      `${JSON.stringify({ attestations: {}, proposals: {}, replays: {}, schemaVersion: 1 })}\n`
    );
    const inventory = captureInventory(fixture.root);
    expect(inventory.policy.source).toBe("repository");
    expect(inventory.localChanges).toEqual([]);
    expect(
      readFileSync(join(fixture.root, ".simple-changes.json"), "utf8")
    ).toBe(policy);
    expect(existsSync(join(ledgerDirectory, "active-loop.json"))).toBe(false);
  });
});
