import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import {
  captureInventory,
  compareSnapshots,
} from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  endLoop,
  OUTCOME_DRAFT_MARKER,
  recordShipmentOutcome,
  recordShipmentScope,
  startLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { buildPreviewPlan } from "../../../skills/simple-changes/scripts/lib/planner.ts";
import {
  draftShipmentOutcome,
  releasePathsFromChangelogReceipt,
} from "../../../skills/simple-changes/scripts/lib/shipment-outcome-draft.ts";
import type { ShipmentOutcomeReceipt } from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(60_000);

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
const reviewed = (draft: ShipmentOutcomeReceipt): ShipmentOutcomeReceipt => ({
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
    expect(report.placeholders).toBe(5);
    expect(report.summary.deletedPaths).toEqual(["obsolete.txt", "SPEC.md"]);
    expect(report.recordCommand).toContain(
      `loop record-outcome --run-id ${lease.runId} --agent-id controller`
    );
    const draft = JSON.parse(
      readFileSync(join(fixture.base, "draft.json"), "utf8")
    ) as ShipmentOutcomeReceipt;
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
    expect(placeholders).toBe(3);
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
    expect(() =>
      recordShipmentOutcome(root, lease.runId, "controller", draft)
    ).toThrow(`summary of unit ${unit?.unitId}`);
    recordShipmentOutcome(root, lease.runId, "controller", reviewed(draft));
    expect(endLoop(root, lease.runId, "controller").ok).toBe(true);
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
