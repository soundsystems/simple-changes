import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import {
  captureInventory,
  compareSnapshots,
} from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  endLoop,
  loopLeasePath,
  OUTCOME_DRAFT_MARKER,
  recordShipmentOutcome,
  recordShipmentScope,
  startLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { buildPreviewPlan } from "../../../skills/simple-changes/scripts/lib/planner.ts";
import { runGit } from "../../../skills/simple-changes/scripts/lib/process.ts";
import { withReadOnlyGit } from "../../../skills/simple-changes/scripts/lib/read-only-git.ts";
import {
  draftShipmentOutcome,
  releasePathsFromChangelogReceipt,
  type ShipmentOutcomeDraftReceipt,
} from "../../../skills/simple-changes/scripts/lib/shipment-outcome-draft.ts";
import type { ShipmentOutcomeReceipt } from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(60_000);

const COMMITTER_LINE = /^(committer .*)$/mu;

let repositories: TestRepository[] = [];
afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

const repository = (): TestRepository => {
  const fixture = createTestRepository();
  repositories.push(fixture);
  return fixture;
};

const commitAll = (root: string, message: string): string => {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
};

const recordCurrentScope = (root: string, runId: string): void => {
  const inventory = captureInventory(root);
  recordShipmentScope(
    root,
    runId,
    "controller",
    buildPreviewPlan(
      inventory,
      inventory,
      compareSnapshots(inventory, inventory),
      "Ship everything ready"
    )
  );
};

// Replaces every draft placeholder, as a reviewing agent would.
// Deletes draftReview and replaces every placeholder, as a reviewer would.
const reviewed = ({
  draftReview: _draftReview,
  ...draft
}: ShipmentOutcomeDraftReceipt): ShipmentOutcomeReceipt => ({
  ...draft,
  additionalPaths: draft.additionalPaths.map((item) => ({
    ...item,
    reason: `Reviewed: ${item.path} reached the target through the merged proposal.`,
  })),
  units: draft.units.map((unit) => ({
    ...unit,
    evidence: ["Reviewed and checked at the final target."],
    summary: `Delivered ${unit.unitId}.`,
  })),
});

const cliPath = fileURLToPath(
  new URL(
    "../../../skills/simple-changes/scripts/simple-changes.ts",
    import.meta.url
  )
);

describe("loop draft-outcome", () => {
  test("drafts every final-target path, with null entries for deletions, and refuses to record placeholders", () => {
    const fixture = repository();
    const { root } = fixture;
    writeFixture(root, "SPEC.md", "# Spec\n");
    writeFixture(root, "CHANGELOG.md", "# Changelog\n");
    writeFixture(root, "obsolete.txt", "remove me\n");
    commitAll(root, "Base fixture");
    // A clean Ship start records its empty scope itself.
    const lease = startLoop(root, "controller", "ship");
    expect(lease.shipmentScope?.plan.units).toEqual([]);

    // External target movement after loop start: a move, a deletion, an
    // edit, and a release-prepared changelog.
    git(root, ["mv", "SPEC.md", "docs-SPEC.md"]);
    git(root, ["rm", "-q", "obsolete.txt"]);
    writeFixture(root, "README.md", "# Fixture\n\nReviewed change.\n");
    commitAll(root, "Merge the reviewed proposal");
    writeFixture(root, "CHANGELOG.md", "# Changelog\n\n## 1.0.0\n");
    const target = commitAll(root, "Prepare the release");
    const changelogReceipt = join(fixture.base, "prepared.json");
    writeFileSync(
      changelogReceipt,
      JSON.stringify({ paths: [{ digest: "x", path: "CHANGELOG.md" }] })
    );

    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "draft-outcome",
        "--run-id",
        lease.runId,
        "--changelog-receipt",
        changelogReceipt,
        "--output",
        join(fixture.base, "draft.json"),
        "--json",
      ],
      {
        cwd: root,
        env: { ...process.env, SIMPLE_CHANGES_SKILL_ROOTS: "" },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const decoder = new TextDecoder();
    expect(decoder.decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(decoder.decode(result.stdout)) as {
      placeholders: number;
      recordCommand: string;
      summary: { deletedPaths: string[] };
    };
    expect(report.placeholders).toBe(6);
    expect(report.summary.deletedPaths).toEqual(["obsolete.txt", "SPEC.md"]);
    expect(report.recordCommand).toContain(
      `loop record-outcome --run-id ${lease.runId} --agent-id controller`
    );
    const draft = JSON.parse(
      readFileSync(join(fixture.base, "draft.json"), "utf8")
    ) as ShipmentOutcomeDraftReceipt;
    expect(draft.targetRevision).toBe(target);
    expect(draft.units).toEqual([]);
    expect(
      draft.additionalPaths.map(({ classification, entry, path }) => ({
        classification,
        deleted: entry === null,
        path,
      }))
    ).toEqual([
      {
        classification: "release-generated",
        deleted: false,
        path: "CHANGELOG.md",
      },
      {
        classification: "external-target-change",
        deleted: false,
        path: "docs-SPEC.md",
      },
      {
        classification: "external-target-change",
        deleted: true,
        path: "obsolete.txt",
      },
      {
        classification: "external-target-change",
        deleted: false,
        path: "README.md",
      },
      {
        classification: "external-target-change",
        deleted: true,
        path: "SPEC.md",
      },
    ]);
    for (const item of draft.additionalPaths) {
      expect(item.reason.startsWith(OUTCOME_DRAFT_MARKER)).toBe(true);
      expect(item.reason).toContain("commits since loop start:");
    }

    expect(() =>
      recordShipmentOutcome(root, lease.runId, "controller", draft)
    ).toThrow("still an unreviewed loop draft-outcome draft");
    const { draftReview: _draftReview, ...undeclared } = draft;
    expect(() =>
      recordShipmentOutcome(root, lease.runId, "controller", undeclared)
    ).toThrow("draft placeholder");
    const partly = reviewed(draft);
    const last = partly.additionalPaths.at(-1);
    if (last) {
      last.reason = `${OUTCOME_DRAFT_MARKER} still unreviewed`;
    }
    expect(() =>
      recordShipmentOutcome(root, lease.runId, "controller", partly)
    ).toThrow("reason for SPEC.md");
    recordShipmentOutcome(root, lease.runId, "controller", reviewed(draft));
    expect(endLoop(root, lease.runId, "controller").ok).toBe(true);
  });

  test("pre-fills scoped units with their exact final entries", () => {
    const fixture = repository();
    const { root } = fixture;
    writeFixture(root, "contact.ts", "export const email = 'old';\n");
    commitAll(root, "Base fixture");
    writeFixture(root, "contact.ts", "export const email = 'new';\n");
    const lease = startLoop(root, "controller", "ship");
    recordCurrentScope(root, lease.runId);
    commitAll(root, "Ship the scoped change");
    writeFixture(root, "unrelated.md", "Arrived from elsewhere.\n");
    commitAll(root, "External change");

    const { draft, placeholders, summary } = draftShipmentOutcome(
      root,
      lease.runId
    );

    expect(summary).toMatchObject({ additionalPaths: 1, units: 1 });
    expect(placeholders).toBe(4);
    const [unit] = draft.units;
    expect(unit?.disposition).toBe("delivered");
    expect(unit?.finalPaths).toEqual([
      {
        entry: `100644:blob:${git(root, ["rev-parse", "HEAD:contact.ts"])}`,
        path: "contact.ts",
      },
    ]);
    expect(unit?.summary.startsWith(OUTCOME_DRAFT_MARKER)).toBe(true);
    expect(draft.additionalPaths.map((item) => item.path)).toEqual([
      "unrelated.md",
    ]);
    // Each placeholder is refused on its own, not only the first one.
    const summaryOnly = reviewed(draft);
    const [summaryUnit] = summaryOnly.units;
    if (summaryUnit) {
      summaryUnit.summary = `${OUTCOME_DRAFT_MARKER} unreviewed`;
    }
    expect(() =>
      recordShipmentOutcome(root, lease.runId, "controller", summaryOnly)
    ).toThrow(`summary of unit ${unit?.unitId}`);
    const evidenceOnly = reviewed(draft);
    const [evidenceUnit] = evidenceOnly.units;
    if (evidenceUnit) {
      evidenceUnit.evidence = [
        "Checked.",
        `${OUTCOME_DRAFT_MARKER} unreviewed`,
      ];
    }
    expect(() =>
      recordShipmentOutcome(root, lease.runId, "controller", evidenceOnly)
    ).toThrow(`evidence of unit ${unit?.unitId}`);
    recordShipmentOutcome(root, lease.runId, "controller", reviewed(draft));
    expect(endLoop(root, lease.runId, "controller").ok).toBe(true);
  });

  test("reads a file named like pathspec magic as that file, in the draft and the recorder", () => {
    const fixture = repository();
    const { root } = fixture;
    writeFixture(root, "README.md", "plain\n");
    writeFixture(root, "notes.md", "notes\n");
    writeFixture(root, ":notes.md", "colon notes\n");
    commitAll(root, "Base fixture");
    const lease = startLoop(root, "controller", "ship");
    // `:README.md` arrives beside an unchanged `README.md`, and `:notes.md`
    // is deleted while `notes.md` stays. Read as pathspecs, both names would
    // resolve to the plain file's entry.
    writeFixture(root, ":README.md", "colon readme\n");
    rmSync(join(root, ":notes.md"));
    commitAll(root, "External change");

    const { draft } = draftShipmentOutcome(root, lease.runId);
    const entries = Object.fromEntries(
      draft.additionalPaths.map(({ entry, path }) => [path, entry])
    );
    expect(entries).toEqual({
      ":notes.md": null,
      ":README.md": `100644:blob:${git(root, ["rev-parse", "HEAD::README.md"])}`,
    });
    recordShipmentOutcome(root, lease.runId, "controller", reviewed(draft));
    expect(endLoop(root, lease.runId, "controller").ok).toBe(true);
  });

  test("binds the target branch, never a tag named like it, in the draft and the recorder", () => {
    // A local target (`main`) and a remote-tracking target (`origin/main`):
    // Git resolves a short name to a same-named tag before the branch, so a
    // tag at the old head must not hide the target's later change.
    for (const remote of [false, true]) {
      const fixture = repository();
      const { base, root } = fixture;
      const before = git(root, ["rev-parse", "HEAD"]);
      if (remote) {
        const bare = join(base, "origin.git");
        git(base, ["clone", "-q", "--bare", root, bare]);
        git(root, ["remote", "add", "origin", bare]);
        git(root, ["fetch", "-q", "origin"]);
        git(root, ["branch", "-q", "-u", "origin/main", "main"]);
      }
      const lease = startLoop(root, "controller", "ship");
      const targetRef = remote ? "origin/main" : "main";
      expect(lease.targetRef).toBe(targetRef);
      writeFixture(root, "arrived.txt", "after loop start\n");
      const after = commitAll(root, "Target change");
      if (remote) {
        git(root, ["push", "-q", "origin", "main"]);
        git(root, ["fetch", "-q", "origin"]);
      }
      git(root, ["tag", targetRef, before]);

      const { draft } = draftShipmentOutcome(root, lease.runId);
      expect(draft.targetRevision).toBe(after);
      expect(draft.additionalPaths.map((item) => item.path)).toEqual([
        "arrived.txt",
      ]);
      recordShipmentOutcome(root, lease.runId, "controller", reviewed(draft));
      // Ending the run still checks the local branch by its short name, which
      // the tag answers, so it refuses rather than pass; drop the tag first.
      git(root, ["tag", "-d", targetRef]);
      expect(endLoop(root, lease.runId, "controller").ok).toBe(true);
    }
  });

  test("an empty draft still needs its review marker deleted", () => {
    const fixture = repository();
    const { root } = fixture;
    const lease = startLoop(root, "controller", "ship");

    const { draft, placeholders } = draftShipmentOutcome(root, lease.runId);

    expect(draft).toMatchObject({ additionalPaths: [], units: [] });
    expect(placeholders).toBe(1);
    expect(() =>
      recordShipmentOutcome(root, lease.runId, "controller", draft)
    ).toThrow("still an unreviewed loop draft-outcome draft");
    recordShipmentOutcome(root, lease.runId, "controller", reviewed(draft));
  });

  test("records scoped rename originals and gitlinks exactly", () => {
    const fixture = repository();
    const { root } = fixture;
    writeFixture(root, "old-name.ts", "export const name = 'kept';\n");
    commitAll(root, "Base fixture");
    git(root, ["mv", "old-name.ts", "new-name.ts"]);
    const lease = startLoop(root, "controller", "ship");
    recordCurrentScope(root, lease.runId);
    commitAll(root, "Ship the rename");
    const submodule = git(root, ["rev-parse", "HEAD"]);
    git(root, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${submodule},vendor/module`,
    ]);
    git(root, ["commit", "-m", "Pin a module"]);
    // An unpopulated submodule is an empty directory.
    mkdirSync(join(root, "vendor", "module"), { recursive: true });

    const { draft } = draftShipmentOutcome(root, lease.runId);

    const paths = [
      ...draft.units.flatMap((item) => [
        ...item.finalPaths,
        ...item.originalPaths,
      ]),
      ...draft.additionalPaths,
    ].map(({ entry, path }) => ({ entry, path }));
    expect(paths).toContainEqual({ entry: null, path: "old-name.ts" });
    expect(paths).toContainEqual({
      entry: `160000:commit:${submodule}`,
      path: "vendor/module",
    });
    recordShipmentOutcome(root, lease.runId, "controller", reviewed(draft));
    expect(endLoop(root, lease.runId, "controller").ok).toBe(true);
  });

  test("suggests target-equivalent for a scoped unit the target did not change", () => {
    const fixture = repository();
    const { root } = fixture;
    writeFixture(root, "notes.md", "draft\n");
    commitAll(root, "Base fixture");
    writeFixture(root, "notes.md", "draft, revised\n");
    const lease = startLoop(root, "controller", "ship");
    recordCurrentScope(root, lease.runId);

    const { draft } = draftShipmentOutcome(root, lease.runId);

    expect(draft.units.map((unit) => unit.disposition)).toEqual([
      "target-equivalent",
    ]);
    expect(draft.additionalPaths).toEqual([]);
  });

  test("refuses to draft an unreadable scoped file as deleted", () => {
    const fixture = repository();
    const { root } = fixture;
    writeFixture(root, "docs/guides/notes.md", "draft\n");
    commitAll(root, "Base fixture");
    writeFixture(root, "docs/guides/notes.md", "draft, revised\n");
    const lease = startLoop(root, "controller", "ship");
    recordCurrentScope(root, lease.runId);
    // The opening and final targets match, so neither diff reads a tree;
    // only the entry lookup reaches the missing subtree.
    const subtree = git(root, ["rev-parse", "HEAD:docs/guides"]);
    const objects = git(root, ["rev-parse", "--git-path", "objects"]);
    rmSync(resolve(root, objects, subtree.slice(0, 2), subtree.slice(2)));

    expect(() => draftShipmentOutcome(root, lease.runId)).toThrow(
      "Cannot read docs/guides/notes.md at "
    );
    const cli = spawnSync(
      [
        "bun",
        cliPath,
        "loop",
        "draft-outcome",
        "--run-id",
        lease.runId,
        "--json",
        "--repo",
        root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(cli.exitCode).not.toBe(0);
    expect(cli.stdout.toString()).not.toContain('"entry":null');
  });

  test("never runs a signature verifier, even with log.showSignature set", () => {
    const fixture = repository();
    const { base, root } = fixture;
    writeFixture(root, "notes.md", "draft\n");
    commitAll(root, "Base fixture");
    const lease = startLoop(root, "controller", "ship");
    writeFixture(root, "notes.md", "draft, landed\n");
    commitAll(root, "Land the notes");
    // Re-create the target commit with a signature header, then point Git's
    // verifier at a stand-in that records each run.
    const signed = git(root, ["cat-file", "commit", "HEAD"]).replace(
      COMMITTER_LINE,
      "$1\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n c2lnbmF0dXJl\n -----END PGP SIGNATURE-----"
    );
    const commitFile = join(base, "signed-commit.txt");
    writeFileSync(commitFile, `${signed}\n`);
    git(root, [
      "update-ref",
      "HEAD",
      git(root, ["hash-object", "-t", "commit", "-w", commitFile]),
    ]);
    const marker = join(base, "verifier-ran");
    const verifier = join(base, "fake-gpg");
    writeFileSync(verifier, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(verifier, 0o755);
    git(root, ["config", "gpg.program", verifier]);
    git(root, ["config", "log.showSignature", "true"]);
    git(root, ["log", "-1", "--format=%h"]);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    const { draft } = draftShipmentOutcome(root, lease.runId);
    expect(draft.additionalPaths.map((item) => item.path)).toEqual([
      "notes.md",
    ]);
    withReadOnlyGit(() => runGit(root, ["log", "-1", "--format=%h"]));
    const cli = spawnSync(
      [
        "bun",
        cliPath,
        "loop",
        "draft-outcome",
        "--run-id",
        lease.runId,
        "--json",
        "--repo",
        root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(cli.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test("never fetches a missing object to draft from a partial clone", () => {
    const fixture = repository();
    const source = fixture.root;
    git(source, ["config", "uploadpack.allowFilter", "true"]);
    writeFixture(source, "SPEC.md", `${"Specification line.\n".repeat(40)}`);
    commitAll(source, "Base fixture");
    const clone = join(fixture.base, "partial");
    git(fixture.base, [
      "clone",
      "-q",
      "--filter=blob:none",
      `file://${source}`,
      clone,
    ]);
    git(clone, ["config", "user.name", "Draft Tests"]);
    git(clone, ["config", "user.email", "draft@simple-changes.invalid"]);
    const lease = startLoop(clone, "controller", "ship");
    git(source, ["mv", "SPEC.md", "docs-SPEC.md"]);
    writeFixture(
      source,
      "docs-SPEC.md",
      `${"Specification line.\n".repeat(39)}Moved.\n`
    );
    const moved = commitAll(source, "Move the spec");
    git(clone, ["fetch", "-q", "origin"]);
    const blob = git(source, ["rev-parse", `${moved}:docs-SPEC.md`]);
    const present = () =>
      spawnSync(["git", "-C", clone, "cat-file", "-e", blob], {
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
        stderr: "pipe",
      }).exitCode === 0;
    expect(present()).toBe(false);

    expect(() => draftShipmentOutcome(clone, lease.runId)).toThrow();
    expect(present()).toBe(false);
  });

  test("lists a changed gitlink even where submodules are ignored", () => {
    const fixture = repository();
    const { root } = fixture;
    const first = git(root, ["rev-parse", "HEAD"]);
    git(root, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${first},vendor/module`,
    ]);
    git(root, ["commit", "-q", "-m", "Pin a module"]);
    mkdirSync(join(root, "vendor", "module"), { recursive: true });
    git(root, ["config", "diff.ignoreSubmodules", "all"]);
    const lease = startLoop(root, "controller", "ship");
    const second = git(root, ["rev-parse", "HEAD"]);
    git(root, [
      "update-index",
      "--cacheinfo",
      `160000,${second},vendor/module`,
    ]);
    git(root, ["commit", "-q", "-m", "Move the module pin"]);

    const { draft } = draftShipmentOutcome(root, lease.runId);

    expect(draft.additionalPaths).toEqual([
      expect.objectContaining({
        entry: `160000:commit:${second}`,
        path: "vendor/module",
      }),
    ]);
    recordShipmentOutcome(root, lease.runId, "controller", reviewed(draft));
  });

  test("refuses placeholders anywhere, before reading a preserved-source override", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "ship");
    const receipt = (override: Record<string, string>, summary: string) => ({
      additionalPaths: [],
      runId: lease.runId,
      schemaVersion: 1,
      targetRevision: lease.targetRevision,
      units: [
        {
          disposition: "target-equivalent",
          evidence: ["Reviewed."],
          finalPaths: [],
          originalPaths: [],
          preservedSourceOverride: override,
          summary,
          unitId: "unit-1",
        },
      ],
    });
    expect(() =>
      recordShipmentOutcome(
        fixture.root,
        lease.runId,
        "controller",
        receipt({}, `${OUTCOME_DRAFT_MARKER} unreviewed`)
      )
    ).toThrow("summary of unit unit-1");
    for (const field of [
      "approvalReason",
      "approvalReference",
      "reviewReference",
    ]) {
      expect(() =>
        recordShipmentOutcome(
          fixture.root,
          lease.runId,
          "controller",
          receipt({ [field]: `${OUTCOME_DRAFT_MARKER} unreviewed` }, "Done.")
        )
      ).toThrow(`units[0].preservedSourceOverride.${field}`);
    }
  });

  test("--output never replaces the lease or writes into the state directory", () => {
    const fixture = repository();
    const { root } = fixture;
    const lease = startLoop(root, "controller", "ship");
    const leaseFile = loopLeasePath(join(root, ".git"));
    const before = readFileSync(leaseFile, "utf8");
    const hardLink = join(fixture.base, "lease-link.json");
    linkSync(leaseFile, hardLink);
    mkdirSync(join(root, ".git", "..drafts"));
    for (const output of [
      leaseFile,
      hardLink,
      join(root, ".git", "simple-changes", "draft.json"),
      join(root, ".git", "..drafts", "draft.json"),
    ]) {
      const result = spawnSync(
        [
          process.execPath,
          cliPath,
          "loop",
          "draft-outcome",
          "--run-id",
          lease.runId,
          "--output",
          output,
        ],
        {
          cwd: root,
          env: { ...process.env, SIMPLE_CHANGES_SKILL_ROOTS: "" },
          stderr: "pipe",
          stdout: "pipe",
        }
      );
      expect({ exitCode: result.exitCode, output }).toEqual({
        exitCode: 2,
        output,
      });
    }
    expect(readFileSync(leaseFile, "utf8")).toBe(before);
  });

  test("reads release paths only from a changelog receipt's paths list", () => {
    expect(
      releasePathsFromChangelogReceipt({
        paths: [{ digest: "a", path: "package.json" }],
      })
    ).toEqual(["package.json"]);
    for (const value of [{}, { paths: "x" }, { paths: [{ path: "" }] }, null]) {
      expect(() => releasePathsFromChangelogReceipt(value)).toThrow(
        "--changelog-receipt must be a changelog receipt"
      );
    }
  });
});
