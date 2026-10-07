import {
  afterEach,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
// biome-ignore lint/performance/noNamespaceImport: spyOn must patch the namespace the policy writer's named imports read.
import * as fs from "node:fs";
import {
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import { CURRENT_GUIDANCE_VERSION } from "../../../skills/simple-changes/scripts/lib/guidance-updates.ts";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import { withLoopStateLock } from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import {
  acknowledgementCouldRestoreTrust,
  withAcknowledgedGuidanceText,
  writeGuidanceAcknowledgement,
  writeRepositoryPolicyTrustReceipt,
} from "../../../skills/simple-changes/scripts/lib/policy.ts";
import {
  createTestRepository,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(60_000);
const decoder = new TextDecoder();
const cliPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../skills/simple-changes/scripts/simple-changes.ts"
);
const fixtures: TestRepository[] = [];
afterEach(() => {
  for (const fixture of fixtures) {
    fixture.cleanup();
  }
  fixtures.length = 0;
});

// A saved repository policy in the hand-maintained key order downstream forks
// use, requesting every consequential authority and omitting the keys whose
// defaults a load fills in (`proposalScheduling`, `proposalSignatures`).
const ELEVATED_POLICY = `{
  "schemaVersion": 1,
  "guidance": {
    "disposition": "deferred",
    "version": 22
  },
  "gitPushAuthorization": "configure-harness",
  "changelogHandling": "delegate-if-available",
  "defaultFinish": "ship",
  "questions": "blocking-only",
  "review": "repository-policy",
  "shippingMode": "break-glass",
  "productionDeploy": "allow",
  "concurrentWork": "allow-claimed",
  "handoffTiming": "confirm-ready",
  "migrationHandling": "auto-apply-reviewed",
  "migrationTargets": [
    {
      "provider": "supabase",
      "project": "primary-db",
      "environment": "production"
    }
  ],
  "uiArtifactVersioning": "repository-convention"
}
`;

// The bytes a hand edit of only the two guidance values produces.
const HAND_EDITED_POLICY = ELEVATED_POLICY.replace(
  '"disposition": "deferred",\n    "version": 22',
  `"disposition": "accepted",\n    "version": ${CURRENT_GUIDANCE_VERSION}`
);

const REDUCED_AUTHORITY = {
  gitPushAuthorization: "ask",
  migrationHandling: "ask-after-review",
  migrationTargets: [],
  productionDeploy: "ask",
  shippingMode: "standard",
};

const policyFixture = (contents: string | Buffer): TestRepository => {
  const fixture = createTestRepository();
  fixtures.push(fixture);
  writeFixture(fixture.root, ".simple-changes.json", "");
  writeFileSync(join(fixture.root, ".simple-changes.json"), contents);
  return fixture;
};

const savedPolicy = (fixture: TestRepository): string =>
  readFileSync(join(fixture.root, ".simple-changes.json"), "utf8");

const runCli = (
  fixture: TestRepository,
  args: string[]
): { exitCode: number; stderr: string; stdout: string } => {
  const result = spawnSync(
    [process.execPath, cliPath, ...args, "--json", "--repo", fixture.root],
    {
      env: {
        ...process.env,
        SIMPLE_CHANGES_CONFIG_DIR: join(fixture.base, "configuration"),
        SIMPLE_CHANGES_SKILL_ROOTS: "",
      },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  return {
    exitCode: result.exitCode,
    stderr: decoder.decode(result.stderr),
    stdout: decoder.decode(result.stdout),
  };
};

const acknowledge = (
  fixture: TestRepository,
  disposition = "accepted"
): { exitCode: number; stderr: string; stdout: string } =>
  runCli(fixture, ["acknowledge-update", "--guidance-decision", disposition]);

// Setup's own serialization and receipt, as a teammate confirming the policy
// on this clone would leave them.
const ELEVATED_SETUP = [
  "--finish",
  "ship",
  "--git-push-authorization",
  "configure-harness",
  "--acknowledge-push-scope",
  "--production",
  "allow",
  "--shipping-mode",
  "break-glass",
  "--migration-handling",
  "ask-after-review",
];
const ORDINARY_SETUP = [
  "--finish",
  "integrate",
  "--git-push-authorization",
  "ask",
];

const confirmWithSetup = (answers: string[]): TestRepository => {
  const fixture = createTestRepository();
  fixtures.push(fixture);
  const setup = runCli(fixture, [
    "setup",
    ...answers,
    "--questions",
    "blocking-only",
    "--scope",
    "repository",
    "--yes",
  ]);
  expect(setup.exitCode).toBe(0);
  return fixture;
};

// Rolls only the guidance version back, as checking out an older copy of an
// otherwise unchanged policy does; the receipt stays bound to the newer bytes.
const rollBackGuidance = (fixture: TestRepository): string => {
  const confirmed = savedPolicy(fixture);
  const current = `"version": ${CURRENT_GUIDANCE_VERSION}`;
  expect(confirmed.split(current)).toHaveLength(2);
  writeFileSync(
    join(fixture.root, ".simple-changes.json"),
    confirmed.replace(current, '"version": 22')
  );
  return confirmed;
};

const confirmedDisposition = (confirmed: string): "accepted" | "reviewed" =>
  (
    JSON.parse(confirmed) as {
      guidance: { disposition: "accepted" | "reviewed" };
    }
  ).guidance.disposition;

const repositoryTarget = (fixture: TestRepository) =>
  ({
    commonGitDirectory: join(fixture.root, ".git"),
    primaryCheckout: fixture.root,
    source: "repository",
  }) as const;

const realReadFileSync = fs.readFileSync;

// Runs `change` right after the first read of `path`, standing in for another
// process editing the policy while an acknowledgement is between its read and
// its write. Restore the returned spy when done.
const changeAfterFirstRead = (path: string, change: () => void) => {
  let pending = true;
  return spyOn(fs, "readFileSync").mockImplementation(((
    file: fs.PathOrFileDescriptor,
    options?: Parameters<typeof fs.readFileSync>[1]
  ) => {
    const contents = realReadFileSync(file, options);
    if (pending && file === path) {
      pending = false;
      change();
    }
    return contents;
  }) as typeof fs.readFileSync);
};

const trustReceiptPath = (fixture: TestRepository): string =>
  join(fixture.root, ".git", "simple-changes", "policy-trust.json");

describe("acknowledge-update records guidance in the saved policy only", () => {
  test("an untrusted policy keeps every non-guidance byte, adding no defaults", () => {
    const fixture = policyFixture(ELEVATED_POLICY);
    expect(captureInventory(fixture.root).policy).toMatchObject({
      trust: "untrusted",
      value: REDUCED_AUTHORITY,
    });

    const result = acknowledge(fixture);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      currentVersion: CURRENT_GUIDANCE_VERSION,
      disposition: "accepted",
      previousVersion: 22,
      source: "repository",
      written: true,
    });

    const written = savedPolicy(fixture);
    expect(written).toBe(HAND_EDITED_POLICY);
    // Only the two guidance value lines differ; every other line is identical.
    const before = ELEVATED_POLICY.split("\n");
    const after = written.split("\n");
    expect(after).toHaveLength(before.length);
    expect(
      before.flatMap((line, index) => (line === after[index] ? [] : [index]))
    ).toEqual([3, 4]);
    expect(written).not.toContain("proposalScheduling");
    expect(written).not.toContain("proposalSignatures");
    expect(JSON.parse(written)).toMatchObject({
      gitPushAuthorization: "configure-harness",
      migrationHandling: "auto-apply-reviewed",
      productionDeploy: "allow",
      shippingMode: "break-glass",
    });
  });

  test("acknowledging grants no authority: the effective policy stays reduced", () => {
    const fixture = policyFixture(ELEVATED_POLICY);
    expect(acknowledge(fixture).exitCode).toBe(0);

    // The saved request survives, but nothing confirmed it on this clone.
    expect(existsSync(trustReceiptPath(fixture))).toBe(false);
    expect(captureInventory(fixture.root).policy).toMatchObject({
      source: "repository",
      trust: "untrusted",
      value: REDUCED_AUTHORITY,
    });
    const initialized = spawnSync(
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
    expect(initialized.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(initialized.stdout))).toMatchObject({
      ...REDUCED_AUTHORITY,
      guidanceUpdate: { status: "current" },
      policyTrust: "untrusted",
    });
  });

  test("key order, indentation, line endings, and spacing are preserved", () => {
    const guard = [
      "bun",
      "-e",
      'const x = {"guidance": {"version": 1}}; // \\',
    ];
    const unusual = [
      "{",
      `\t"execGuard": ${JSON.stringify(guard)},`,
      '\t"concurrentWork": "strict",',
      '\t"productionDeploy" : "allow",',
      '\t"migrationTargets": [{"provider": "supabase", "project": "primary-db", "environment": "production"}],',
      '\t"migrationHandling": "auto-apply-reviewed-routine",',
      '\t"review": "independent",',
      '\t"questions": "never",',
      '\t"defaultFinish": "integrate",',
      '\t"schemaVersion": 1,',
      '\t"guidance": {"version": 22}',
      "}",
    ].join("\r\n");
    const fixture = policyFixture(unusual);

    expect(acknowledge(fixture, "reviewed").exitCode).toBe(0);
    expect(savedPolicy(fixture)).toBe(
      unusual.replace(
        '"guidance": {"version": 22}',
        `"guidance": {"disposition": "reviewed", "version": ${CURRENT_GUIDANCE_VERSION}}`
      )
    );
    expect(Object.keys(JSON.parse(savedPolicy(fixture)))).toEqual(
      Object.keys(JSON.parse(unusual))
    );
  });

  test("a trusted policy changes only guidance and its receipt is not renewed", () => {
    const fixture = policyFixture(ELEVATED_POLICY);
    writeRepositoryPolicyTrustReceipt(
      fixture.root,
      join(fixture.root, ".git"),
      "test-user",
      "Authorize this exact test policy"
    );
    const receipt = readFileSync(trustReceiptPath(fixture), "utf8");
    expect(captureInventory(fixture.root).policy).toMatchObject({
      trust: "trusted",
      value: {
        gitPushAuthorization: "configure-harness",
        productionDeploy: "allow",
        shippingMode: "break-glass",
      },
    });

    expect(acknowledge(fixture).exitCode).toBe(0);
    // 0.25.1 also appended default-filled keys here; now only guidance changes.
    expect(savedPolicy(fixture)).toBe(HAND_EDITED_POLICY);
    // As in 0.25.1, the receipt is neither renewed nor removed. It is bound to
    // the previous bytes, so the policy runs reduced until setup confirms it.
    expect(readFileSync(trustReceiptPath(fixture), "utf8")).toBe(receipt);
    expect(captureInventory(fixture.root).policy).toMatchObject({
      trust: "untrusted",
      value: REDUCED_AUTHORITY,
    });
  });

  test("refuses an acknowledgement that would revive a stale trust receipt", () => {
    const fixture = confirmWithSetup(ELEVATED_SETUP);
    const receipt = readFileSync(trustReceiptPath(fixture), "utf8");
    const confirmed = rollBackGuidance(fixture);
    const stale = readFileSync(join(fixture.root, ".simple-changes.json"));
    expect(captureInventory(fixture.root).policy).toMatchObject({
      trust: "untrusted",
      value: REDUCED_AUTHORITY,
    });

    // Recording the confirmed disposition would restore the receipt's bytes.
    const disposition = confirmedDisposition(confirmed);
    const refused = acknowledge(fixture, disposition);
    expect(refused.exitCode).toBe(5);
    expect(refused.stderr).toContain("Nothing was written");
    expect(refused.stderr).toContain("simple-changes setup");
    expect(
      readFileSync(join(fixture.root, ".simple-changes.json")).equals(stale)
    ).toBe(true);
    expect(readFileSync(trustReceiptPath(fixture), "utf8")).toBe(receipt);
    expect(captureInventory(fixture.root).policy).toMatchObject({
      trust: "untrusted",
      value: REDUCED_AUTHORITY,
    });

    // Any other record leaves the receipt unmatched, so it is written.
    const other = disposition === "reviewed" ? "accepted" : "reviewed";
    expect(acknowledge(fixture, other).exitCode).toBe(0);
    expect(savedPolicy(fixture)).toBe(
      confirmed.replace(
        `"disposition": "${disposition}"`,
        `"disposition": "${other}"`
      )
    );
    expect(readFileSync(trustReceiptPath(fixture), "utf8")).toBe(receipt);
    expect(captureInventory(fixture.root).policy).toMatchObject({
      trust: "untrusted",
      value: REDUCED_AUTHORITY,
    });
  });

  test("the stale-receipt check reads only the receipt and fails closed", () => {
    const fixture = confirmWithSetup(ELEVATED_SETUP);
    const confirmed = rollBackGuidance(fixture);
    const stale = savedPolicy(fixture);
    const disposition = confirmedDisposition(confirmed);
    const restoring = withAcknowledgedGuidanceText(stale, {
      disposition,
      version: CURRENT_GUIDANCE_VERSION,
    });
    const other = withAcknowledgedGuidanceText(stale, {
      disposition: disposition === "reviewed" ? "accepted" : "reviewed",
      version: CURRENT_GUIDANCE_VERSION,
    });
    const target = repositoryTarget(fixture);
    expect(restoring).toBe(confirmed);
    expect(acknowledgementCouldRestoreTrust(restoring, target)).toBe(true);
    expect(acknowledgementCouldRestoreTrust(other, target)).toBe(false);

    // A receipt that cannot be read might bind anything, so it refuses.
    const receiptPath = trustReceiptPath(fixture);
    const receipt = readFileSync(receiptPath, "utf8");
    writeFileSync(receiptPath, "{not json");
    expect(acknowledgementCouldRestoreTrust(other, target)).toBe(true);
    writeFileSync(receiptPath, receipt);

    // With no receipt at all, nothing the write produces can be trusted.
    unlinkSync(receiptPath);
    expect(acknowledgementCouldRestoreTrust(restoring, target)).toBe(false);
  });

  test("a policy removed mid-acknowledgement is not recreated as receipt-bound bytes", () => {
    const fixture = confirmWithSetup(ELEVATED_SETUP);
    const confirmed = rollBackGuidance(fixture);
    const path = join(fixture.root, ".simple-changes.json");
    const spy = changeAfterFirstRead(path, () => unlinkSync(path));
    try {
      expect(() =>
        writeGuidanceAcknowledgement(
          path,
          {
            disposition: confirmedDisposition(confirmed),
            version: CURRENT_GUIDANCE_VERSION,
          },
          repositoryTarget(fixture)
        )
      ).toThrow("Nothing was written");
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(path)).toBe(false);
  });

  test("a no-op acknowledgement never overwrites a concurrent edit", () => {
    // The trusted bytes are read, another process replaces them with
    // unconfirmed bytes, and the acknowledgement changes nothing: writing the
    // read bytes back would restore the receipt's match without setup.
    const fixture = confirmWithSetup(ELEVATED_SETUP);
    const confirmed = savedPolicy(fixture);
    const path = join(fixture.root, ".simple-changes.json");
    const concurrent = confirmed.replace(
      `"version": ${CURRENT_GUIDANCE_VERSION}`,
      '"version": 22'
    );
    expect(concurrent).not.toBe(confirmed);
    const spy = changeAfterFirstRead(path, () =>
      writeFileSync(path, concurrent)
    );
    try {
      writeGuidanceAcknowledgement(
        path,
        {
          disposition: confirmedDisposition(confirmed),
          version: CURRENT_GUIDANCE_VERSION,
        },
        repositoryTarget(fixture)
      );
    } finally {
      spy.mockRestore();
    }
    expect(savedPolicy(fixture)).toBe(concurrent);
    expect(captureInventory(fixture.root).policy).toMatchObject({
      trust: "untrusted",
      value: REDUCED_AUTHORITY,
    });
  });

  test("refuses rather than overwrite a policy changed after it was read", () => {
    const fixture = policyFixture(ELEVATED_POLICY);
    const path = join(fixture.root, ".simple-changes.json");
    const concurrent = ELEVATED_POLICY.replace(
      '"questions": "blocking-only"',
      '"questions": "always"'
    );
    expect(concurrent).not.toBe(ELEVATED_POLICY);
    const spy = changeAfterFirstRead(path, () =>
      writeFileSync(path, concurrent)
    );
    try {
      expect(() =>
        writeGuidanceAcknowledgement(
          path,
          { disposition: "accepted", version: CURRENT_GUIDANCE_VERSION },
          repositoryTarget(fixture)
        )
      ).toThrow("nothing was written");
    } finally {
      spy.mockRestore();
    }
    expect(savedPolicy(fixture)).toBe(concurrent);

    // A policy removed meanwhile is not recreated, even with unbound bytes.
    const removal = changeAfterFirstRead(path, () => unlinkSync(path));
    try {
      expect(() =>
        writeGuidanceAcknowledgement(
          path,
          { disposition: "accepted", version: CURRENT_GUIDANCE_VERSION },
          repositoryTarget(fixture)
        )
      ).toThrow("nothing was written");
    } finally {
      removal.mockRestore();
    }
    expect(existsSync(path)).toBe(false);
  });

  test("acknowledge-update and setup write only under the repository state lock", () => {
    const fixture = policyFixture(ELEVATED_POLICY);
    const [acknowledged, confirmed] = withLoopStateLock(
      join(fixture.root, ".git"),
      "test holder",
      () => [
        acknowledge(fixture),
        runCli(fixture, [
          "setup",
          ...ELEVATED_SETUP,
          "--questions",
          "blocking-only",
          "--scope",
          "repository",
          "--yes",
        ]),
      ]
    );
    for (const result of [acknowledged, confirmed]) {
      expect(result.exitCode).toBe(5);
      expect(result.stderr).toContain("busy");
    }
    expect(savedPolicy(fixture)).toBe(ELEVATED_POLICY);
    expect(existsSync(trustReceiptPath(fixture))).toBe(false);
  });

  test("setup cannot publish a receipt inside an acknowledgement's checks", () => {
    // The acknowledgement reads A with no matching receipt. Meanwhile setup
    // confirms B, the acknowledged form of A, and a checkout restores A before
    // the rename; without the shared lock the rename would publish B under
    // setup's fresh receipt.
    const fixture = confirmWithSetup(ELEVATED_SETUP);
    const confirmed = rollBackGuidance(fixture);
    unlinkSync(trustReceiptPath(fixture));
    const path = join(fixture.root, ".simple-changes.json");
    const stale = savedPolicy(fixture);
    let concurrentSetup = { exitCode: 0, stderr: "", stdout: "" };
    const spy = changeAfterFirstRead(path, () => {
      concurrentSetup = runCli(fixture, [
        "setup",
        ...ELEVATED_SETUP,
        "--questions",
        "blocking-only",
        "--scope",
        "repository",
        "--yes",
      ]);
      writeFileSync(path, stale);
    });
    try {
      withLoopStateLock(
        join(fixture.root, ".git"),
        "guidance update acknowledgement",
        () =>
          writeGuidanceAcknowledgement(
            path,
            {
              disposition: confirmedDisposition(confirmed),
              version: CURRENT_GUIDANCE_VERSION,
            },
            repositoryTarget(fixture)
          )
      );
    } finally {
      spy.mockRestore();
    }
    expect(concurrentSetup.exitCode).toBe(5);
    expect(concurrentSetup.stderr).toContain("busy");
    expect(savedPolicy(fixture)).toBe(confirmed);
    expect(existsSync(trustReceiptPath(fixture))).toBe(false);
    expect(captureInventory(fixture.root).policy).toMatchObject({
      trust: "untrusted",
      value: REDUCED_AUTHORITY,
    });
  });

  test("an ordinary confirmed policy may return to its confirmed bytes", () => {
    // Setup writes a receipt for every repository policy, but one requesting
    // no consequential authority needs no trust, so restoring it raises none.
    const fixture = confirmWithSetup(ORDINARY_SETUP);
    expect(existsSync(trustReceiptPath(fixture))).toBe(true);
    const confirmed = rollBackGuidance(fixture);

    expect(acknowledge(fixture, confirmedDisposition(confirmed)).exitCode).toBe(
      0
    );
    expect(savedPolicy(fixture)).toBe(confirmed);
    expect(captureInventory(fixture.root).policy).toMatchObject({
      trust: "not-required",
      value: { gitPushAuthorization: "ask" },
    });
  });

  test("re-acknowledging a trusted policy at the current guidance keeps it trusted", () => {
    const fixture = confirmWithSetup(ELEVATED_SETUP);
    const confirmed = savedPolicy(fixture);
    const receipt = readFileSync(trustReceiptPath(fixture), "utf8");
    const file = statSync(join(fixture.root, ".simple-changes.json"));

    const repeated = acknowledge(fixture, confirmedDisposition(confirmed));
    expect(repeated.exitCode).toBe(0);
    expect(JSON.parse(repeated.stdout)).toMatchObject({ written: false });
    expect(savedPolicy(fixture)).toBe(confirmed);
    // Already recorded, so the file is not replaced at all.
    expect(statSync(join(fixture.root, ".simple-changes.json")).ino).toBe(
      file.ino
    );
    expect(readFileSync(trustReceiptPath(fixture), "utf8")).toBe(receipt);
    expect(captureInventory(fixture.root).policy).toMatchObject({
      trust: "trusted",
      value: {
        gitPushAuthorization: "configure-harness",
        productionDeploy: "allow",
        shippingMode: "break-glass",
      },
    });
  });

  test("personal preferences change only guidance and stay private", () => {
    const fixture = createTestRepository();
    fixtures.push(fixture);
    const preferences = `{
  "schemaVersion": 1,
  "guidance": {
    "version": 22
  },
  "defaultFinish": "integrate",
  "gitPushAuthorization": "never",
  "questions": "always",
  "review": "repository-policy",
  "productionDeploy": "deny",
  "concurrentWork": "strict"
}
`;
    const preferencesPath = join(
      fixture.base,
      "configuration",
      "simple-changes",
      "preferences.json"
    );
    writeFixture(
      fixture.base,
      "configuration/simple-changes/preferences.json",
      preferences
    );

    const result = acknowledge(fixture, "deferred");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ source: "user" });
    expect(readFileSync(preferencesPath, "utf8")).toBe(
      preferences.replace(
        '"version": 22',
        `"disposition": "deferred",\n    "version": ${CURRENT_GUIDANCE_VERSION}`
      )
    );
    if (process.platform !== "win32") {
      expect(statSync(preferencesPath).mode % 0o1000).toBe(0o600);
    }
  });

  test("refuses, unchanged, a policy whose bytes cannot round-trip as UTF-8", () => {
    // JSON.parse reads the lone 0xFF byte as U+FFFD, so the policy loads, but
    // rewriting the decoded text would silently change that saved byte.
    const [prefix, suffix] = ELEVATED_POLICY.replace(
      '  "schemaVersion": 1,\n',
      '  "schemaVersion": 1,\n  "execGuard": ["guard-@@"],\n'
    ).split("@@");
    const invalid = Buffer.concat([
      Buffer.from(prefix as string, "utf8"),
      Buffer.from([0xff]),
      Buffer.from(suffix as string, "utf8"),
    ]);
    const fixture = policyFixture(invalid);
    expect(captureInventory(fixture.root).policy.value.execGuard).toEqual([
      "guard-�",
    ]);

    const result = acknowledge(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not valid UTF-8");
    expect(
      readFileSync(join(fixture.root, ".simple-changes.json")).equals(invalid)
    ).toBe(true);
  });
});

describe("withAcknowledgedGuidanceText", () => {
  const accepted = {
    disposition: "accepted",
    version: CURRENT_GUIDANCE_VERSION,
  } as const;

  test("edits values in place whatever their order", () => {
    const text =
      '{"guidance": {\n "version": 3,\n "disposition": "reviewed"\n}, "schemaVersion": 1}';
    expect(withAcknowledgedGuidanceText(text, accepted)).toBe(
      `{"guidance": {\n "version": ${CURRENT_GUIDANCE_VERSION},\n "disposition": "accepted"\n}, "schemaVersion": 1}`
    );
  });

  test("inserts a missing disposition in the object's own spacing", () => {
    for (const [saved, edited] of [
      [
        '{"guidance":{"version":3}}',
        `{"guidance":{"disposition":"accepted","version":${CURRENT_GUIDANCE_VERSION}}}`,
      ],
      [
        '{"guidance": {"version": 3}}',
        `{"guidance": {"disposition": "accepted", "version": ${CURRENT_GUIDANCE_VERSION}}}`,
      ],
      [
        '{ "guidance": { "version": 3 } }',
        `{ "guidance": { "disposition": "accepted", "version": ${CURRENT_GUIDANCE_VERSION} } }`,
      ],
      [
        '{\n\t"guidance": {\n\t\t"version": 3\n\t}\n}',
        `{\n\t"guidance": {\n\t\t"disposition": "accepted",\n\t\t"version": ${CURRENT_GUIDANCE_VERSION}\n\t}\n}`,
      ],
    ] as const) {
      expect(withAcknowledgedGuidanceText(saved, accepted)).toBe(edited);
    }
  });

  test("edits the member JSON.parse reads, ignoring look-alike text", () => {
    const decoy = JSON.stringify('"guidance": {"version": 1} \\ } ]');
    const text = `{"execGuard": [${decoy}], "guidance": {"version": 1}, "guid\\u0061nce": {"version": 2}}`;
    expect(withAcknowledgedGuidanceText(text, accepted)).toBe(
      `{"execGuard": [${decoy}], "guidance": {"version": 1}, "guid\\u0061nce": {"disposition": "accepted", "version": ${CURRENT_GUIDANCE_VERSION}}}`
    );
  });

  test("refuses text without a guidance version", () => {
    for (const text of ['{"schemaVersion": 1}', '{"guidance": {}}', "[]"]) {
      expect(() => withAcknowledgedGuidanceText(text, accepted)).toThrow(
        "Cannot locate the guidance fields"
      );
    }
  });
});
