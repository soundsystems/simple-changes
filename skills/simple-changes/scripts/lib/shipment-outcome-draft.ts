import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import {
  OUTCOME_DRAFT_MARKER,
  readLoopLease,
  resolvedCurrentTargetRevision,
  targetDiffPaths,
  targetRenameOriginals,
  targetTreeEntry,
} from "./loop-lease.ts";
import { runGit } from "./process.ts";
import type { ShipmentOutcomeReceipt } from "./types.ts";

/**
 * Pre-fills a `loop record-outcome` receipt from Git for the active run. It
 * only reads: the lease file and Git objects, with no lock and no write.
 * Every reason, summary, and evidence item is a placeholder carrying
 * `OUTCOME_DRAFT_MARKER`, which `loop record-outcome` refuses, so the draft
 * cannot be recorded until a person or agent has reviewed and replaced each
 * one. Classifications and unit dispositions are suggestions to check.
 */

const COMMIT_CONTEXT_LIMIT = 6;

export interface ShipmentOutcomeDraft {
  draft: ShipmentOutcomeReceipt;
  placeholders: number;
  recordCommand: string;
  summary: {
    additionalPaths: number;
    deletedPaths: string[];
    externalTargetChanges: number;
    openingTargetRevision: string;
    releaseGenerated: number;
    targetRevision: string;
    units: number;
  };
  warnings: string[];
}

/**
 * Short commit IDs that changed each path between the opening and final
 * target, newest first, from one `git log` call. Merge commits list no paths,
 * so a path reached only through a merge shows the commits it merged.
 */
const commitsByPath = (
  repositoryPath: string,
  openingRevision: string,
  finalRevision: string
): Map<string, string[]> => {
  const commits = new Map<string, string[]>();
  const output = runGit(repositoryPath, [
    "log",
    "--format=%x01%h",
    "--name-only",
    "--no-renames",
    "-z",
    `${openingRevision}..${finalRevision}`,
  ]).stdout;
  for (const record of output.split("\u0001")) {
    const [commit, ...paths] = record.split("\0");
    if (!commit) {
      continue;
    }
    for (const raw of paths) {
      const path = raw.startsWith("\n") ? raw.slice(1) : raw;
      if (path) {
        commits.set(path, [...(commits.get(path) ?? []), commit]);
      }
    }
  }
  return commits;
};

const commitContext = (
  commits: ReadonlyMap<string, readonly string[]>,
  paths: readonly string[]
): string => {
  const touched = [
    ...new Set(paths.flatMap((path) => commits.get(path) ?? [])),
  ];
  if (touched.length === 0) {
    return "no commit since loop start changed it";
  }
  const shown = touched.slice(0, COMMIT_CONTEXT_LIMIT).join(", ");
  const more = touched.length - COMMIT_CONTEXT_LIMIT;
  return `commits since loop start: ${shown}${more > 0 ? ` and ${more} more` : ""}`;
};

/**
 * The paths a changelog receipt says release preparation wrote: its
 * `paths[].path` entries. Anything else is not a changelog receipt.
 */
export const releasePathsFromChangelogReceipt = (value: unknown): string[] => {
  const paths = (value as { paths?: unknown } | null)?.paths;
  if (
    !Array.isArray(paths) ||
    paths.some(
      (item) =>
        typeof (item as { path?: unknown } | null)?.path !== "string" ||
        !(item as { path: string }).path
    )
  ) {
    throw new SimpleChangesError(
      "--changelog-receipt must be a changelog receipt whose paths list names each release-prepared file.",
      EXIT_CODES.usage
    );
  }
  return (paths as Array<{ path: string }>).map((item) => item.path);
};

export const draftShipmentOutcome = (
  repositoryPath: string,
  runId: string,
  options: { releasePaths?: readonly string[] } = {}
): ShipmentOutcomeDraft => {
  const lease = readLoopLease(repositoryPath);
  if (!lease || lease.runId !== runId) {
    throw new SimpleChangesError(
      `Active loop does not match ${runId}.`,
      EXIT_CODES.unsafe
    );
  }
  const root = lease.primaryCheckout;
  const targetRevision = resolvedCurrentTargetRevision(lease);
  if (!targetRevision) {
    throw new SimpleChangesError(
      `Cannot resolve current target ${lease.targetRef}.`,
      EXIT_CODES.unsafe
    );
  }
  const opening = lease.targetRevision;
  const delta = targetDiffPaths(root, opening, targetRevision);
  const deltaSet = new Set(delta);
  const renameOriginals = targetRenameOriginals(root, opening, targetRevision);
  const entry = (path: string) => targetTreeEntry(root, targetRevision, path);
  const commits = commitsByPath(root, opening, targetRevision);
  const context = (paths: readonly string[]) => commitContext(commits, paths);
  const warnings: string[] = [];
  if (!lease.shipmentScope) {
    warnings.push(
      "This run has no recorded shipment scope; loop record-outcome refuses an outcome until one is recorded."
    );
  }
  if (lease.shipmentOutcome) {
    warnings.push(
      `This run already recorded an outcome at ${lease.shipmentOutcome.recordedAt}; recording again replaces it.`
    );
  }
  const units = (lease.shipmentScope?.plan.units ?? []).map((unit) => {
    const originals = [
      ...new Set(
        unit.paths
          .map((path) => renameOriginals.get(path))
          .filter(
            (path): path is string => path !== undefined && deltaSet.has(path)
          )
      ),
    ].sort((left, right) => left.localeCompare(right));
    const moved = unit.paths.some((path) => deltaSet.has(path));
    return {
      // Scoped paths that did not change since loop start were already in
      // the target; changed ones arrived during the run.
      disposition: moved
        ? ("delivered" as const)
        : ("target-equivalent" as const),
      evidence: [
        `${OUTCOME_DRAFT_MARKER} replace with the review and verification evidence for this unit (${context(unit.paths)}).`.slice(
          0,
          500
        ),
      ],
      finalPaths: unit.paths.map((path) => ({ entry: entry(path), path })),
      originalPaths: originals.map((path) => ({ entry: entry(path), path })),
      summary:
        `${OUTCOME_DRAFT_MARKER} replace with what unit ${unit.id} delivered: ${unit.title}`.slice(
          0,
          500
        ),
      unitId: unit.id,
    };
  });
  const accounted = new Set([
    ...units.flatMap((unit) => unit.finalPaths.map((item) => item.path)),
    ...units.flatMap((unit) => unit.originalPaths.map((item) => item.path)),
  ]);
  const releasePaths = new Set(options.releasePaths ?? []);
  const additionalPaths = delta
    .filter((path) => !accounted.has(path))
    .map((path) => {
      const released = releasePaths.has(path);
      return {
        classification: released
          ? ("release-generated" as const)
          : ("external-target-change" as const),
        entry: entry(path),
        path,
        reason: `${OUTCOME_DRAFT_MARKER} ${
          released
            ? "name the release preparation that wrote this path"
            : "name the reviewed change that brought this path into the target, such as the merged proposal and its exact head"
        } (${context([path])}).`.slice(0, 500),
      };
    });
  const draft: ShipmentOutcomeReceipt = {
    additionalPaths,
    runId: lease.runId,
    schemaVersion: 1,
    targetRevision,
    units,
  };
  const releaseGenerated = additionalPaths.filter(
    (item) => item.classification === "release-generated"
  ).length;
  return {
    draft,
    placeholders: units.length * 2 + additionalPaths.length,
    recordCommand: `simple-changes loop record-outcome --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --receipt <reviewed file>`,
    summary: {
      additionalPaths: additionalPaths.length,
      deletedPaths: [
        ...units.flatMap((unit) => [...unit.finalPaths, ...unit.originalPaths]),
        ...additionalPaths,
      ]
        .filter((item) => item.entry === null)
        .map((item) => item.path),
      externalTargetChanges: additionalPaths.length - releaseGenerated,
      openingTargetRevision: opening,
      releaseGenerated,
      targetRevision,
      units: units.length,
    },
    warnings,
  };
};
