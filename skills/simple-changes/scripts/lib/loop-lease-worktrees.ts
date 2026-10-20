import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  CHANGELOG_AUTHOR_PURPOSE,
  readChangelogAuthors,
  writeChangelogAuthors,
} from "./changelog-authors.ts";
import { releaseSurfacesIn } from "./changelog-coordination.ts";
import {
  PATCH_EQUIVALENCE_MAX_COMMITS,
  type TargetContainmentMethod,
  targetContainmentAudit,
} from "./cleanup-core.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import {
  assertExactBranch,
  captureInventory,
  locateRepository,
} from "./inventory.ts";
import {
  assertControllerActive,
  assertMatchingRun,
  assertNewAuthorPreparationAllowed,
  assertShipmentScopeRecorded,
  currentTargetRevision,
  DIGEST_PATTERN,
  effectiveShipmentScopeFrozenAt,
  exactWorktreeLease,
  readLeaseFromCommonDirectory,
  requiredText,
  requireLease,
  requireOwnedLease,
  targetUsesGitLab,
  withMutationEvidence,
  withStateLock,
  writeLease,
} from "./loop-lease-core.ts";
import { verificationAgainst } from "./loop-lease-verify.ts";
import { preparedWorktreePath, slug } from "./managed-worktrees.ts";
import { runGit } from "./process.ts";
import type {
  ChangelogAuthorBinding,
  LoopLease,
  LoopOverride,
  LoopWorktreeDisposition,
  LoopWorktreeLease,
  LoopWorktreePreparation,
  RepositoryInventory,
  WorktreeInventory,
} from "./types.ts";
import { markCoordinationResumeReady } from "./worktree-coordination.ts";

const assertLegacyRunAllowsMutation = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  message: string
): void => {
  if (targetUsesGitLab(inventory) && !lease.openingRemoteInventory) {
    throw new SimpleChangesError(message, EXIT_CODES.unsafe);
  }
};

// Whether anything, even a dangling symbolic link, already holds `path`.
const pathEntryExists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
};

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

export interface PreparedAgentWorktree {
  agentId: string;
  baseRevision: string;
  branch: string;
  /**
   * Present only for a changelog-only author added to a registered unit
   * after the shipment scope froze: the unit, and the only paths it may
   * change.
   */
  changelogAuthor?: { releaseSurfaces: string[]; unitId: string };
  created: boolean;
  path: string;
  runId: string;
}

/**
 * The release surfaces a changelog-only author may change, once `prepare-agent
 * --unit` has shown that it may join the unit: the run's scope froze, the
 * purpose is a changelog, the frozen scope registers the unit, and the
 * repository holds at least one release surface. Anything else is refused;
 * it never creates a unit or widens the scope.
 */
const changelogAuthorSurfaces = (
  lease: LoopLease,
  unitId: string,
  purpose: string
): string[] => {
  if (purpose !== CHANGELOG_AUTHOR_PURPOSE) {
    throw new SimpleChangesError(
      `--unit prepares only a changelog author, so pass --purpose ${CHANGELOG_AUTHOR_PURPOSE}. Any other author would widen a shipment whose scope froze.`,
      EXIT_CODES.usage
    );
  }
  if (!effectiveShipmentScopeFrozenAt(lease)) {
    throw new SimpleChangesError(
      `--unit adds a changelog author to a registered unit only after the shipment scope of ${lease.runId} froze, and this run's scope has not frozen. Prepare the author without --unit.`,
      EXIT_CODES.unsafe
    );
  }
  const units = lease.shipmentScope?.plan.units ?? [];
  if (!units.some((unit) => unit.id === unitId)) {
    throw new SimpleChangesError(
      `Unit ${JSON.stringify(unitId)} is not registered in the frozen shipment scope of ${lease.runId} (registered units: ${units.map((unit) => unit.id).join(", ") || "none"}). A changelog author joins only a registered unit and never adds one.`,
      EXIT_CODES.unsafe
    );
  }
  const surfaces = releaseSurfacesIn(lease.primaryCheckout);
  if (surfaces.length === 0) {
    throw new SimpleChangesError(
      `${lease.primaryCheckout} holds no release surface (a changelog or Simple Changelogs policy file), so a changelog-only author would have nothing it may change.`,
      EXIT_CODES.unsafe
    );
  }
  return surfaces;
};

// `--unit` adds a new author, or returns one it already bound to that unit;
// it never binds an author registered or being prepared some other way.
const assertChangelogBinding = (
  agentId: string,
  unitId: string | null,
  binding: ChangelogAuthorBinding | undefined,
  registeredPath: string
): void => {
  if (
    unitId !== null &&
    !(binding && binding.unitId === unitId && binding.path === registeredPath)
  ) {
    throw new SimpleChangesError(
      `Agent ${agentId} is already registered or being prepared at ${registeredPath} without being bound to unit ${JSON.stringify(unitId)} as its changelog author. Use a new agent ID for the changelog author.`,
      EXIT_CODES.unsafe
    );
  }
};

// Records a new preparation's changelog binding, or drops a stale binding
// for its agent when it is an ordinary author. The binding is written before
// the preparation, so the author is never registered unbound; a binding left
// by an attempt that stopped before the lease recorded it binds nobody and is
// replaced here.
const bindChangelogAuthor = (
  lease: LoopLease,
  bindings: ChangelogAuthorBinding[],
  preparation: LoopWorktreePreparation,
  changelog: { releaseSurfaces: string[]; unitId: string } | null
): void => {
  const others = bindings.filter(
    (item) => item.agentId !== preparation.agentId
  );
  if (changelog) {
    writeChangelogAuthors(lease, [
      ...others,
      {
        agentId: preparation.agentId,
        baseRevision: preparation.baseRevision,
        branch: preparation.branch,
        path: preparation.path,
        recordedAt: preparation.createdAt,
        releaseSurfaces: changelog.releaseSurfaces,
        unitId: changelog.unitId,
      },
    ]);
  } else if (others.length !== bindings.length) {
    writeChangelogAuthors(lease, others);
  }
};

/**
 * Whether a new author may be prepared: after the scope froze, only a
 * changelog author for a registered unit, whose release surfaces this
 * returns. Null means an ordinary author.
 */
const newAuthorReleaseSurfaces = (
  lease: LoopLease,
  unitId: string | null,
  purpose: string
): string[] | null => {
  if (unitId !== null) {
    return changelogAuthorSurfaces(lease, unitId, purpose);
  }
  assertNewAuthorPreparationAllowed(lease);
  return null;
};

// An agent's existing registration, which prepare-agent returns unchanged.
const reusedRegistration = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  existing: LoopWorktreeLease,
  binding: ChangelogAuthorBinding | undefined
): PreparedAgentWorktree => {
  const agentId = existing.agentId as string;
  if (!(existing.branch && existing.mutationAllowed)) {
    throw new SimpleChangesError(
      `Agent ${agentId} is registered without an authoring worktree.`,
      EXIT_CODES.unsafe
    );
  }
  const existingWorktree = inventory.worktrees.find(
    (worktree) => worktree.path === existing.path
  );
  if (!existingWorktree || existingWorktree.branch !== existing.branch) {
    throw new SimpleChangesError(
      `Agent ${agentId} must resume prepared path ${existing.path} on registered branch ${existing.branch}; current branch is ${existingWorktree?.branch ?? "missing or detached"}.`,
      EXIT_CODES.unsafe
    );
  }
  return {
    agentId,
    baseRevision: existing.baselineHeadSha ?? lease.targetRevision,
    branch: existing.branch,
    created: false,
    path: existing.path,
    runId: lease.runId,
    ...changelogAuthorReport(
      binding?.path === existing.path ? binding : undefined
    ),
  };
};

// What prepare-agent reports about a changelog-only author.
const changelogAuthorReport = (
  binding: ChangelogAuthorBinding | undefined
): Pick<PreparedAgentWorktree, "changelogAuthor"> =>
  binding
    ? {
        changelogAuthor: {
          releaseSurfaces: [...binding.releaseSurfaces],
          unitId: binding.unitId,
        },
      }
    : {};

/**
 * Prepares, or returns the existing registration of, the agent's worktree
 * under the loop state lock. `onPrepared` runs under that same lock, for a
 * new and a reused preparation alike, after the lease is re-read and still
 * names the run, so state bound to the run there (such as the agent's work
 * directory) cannot race `workdir` or a closing run.
 */
export const prepareAgentWorktree = (
  repositoryPath: string,
  runId: string,
  agentIdInput: string,
  purposeInput: string,
  onPrepared?: (prepared: PreparedAgentWorktree) => void,
  // `--unit`: add a changelog-only author to this registered unit after the
  // shipment scope froze.
  unitIdInput?: string
): PreparedAgentWorktree => {
  const agentId = requiredText(agentIdInput, "agent ID");
  const purpose = slug(requiredText(purposeInput, "purpose"), "work");
  const unitId =
    unitIdInput === undefined ? null : requiredText(unitIdInput, "unit ID");
  const opening = locateRepository(repositoryPath);
  const prepared = (result: PreparedAgentWorktree): PreparedAgentWorktree => {
    if (onPrepared) {
      const current = readLeaseFromCommonDirectory(
        opening.repository.commonGitDirectory
      );
      if (current?.runId !== result.runId) {
        throw new SimpleChangesError(
          `Run ${result.runId} is no longer active; agent ${agentId} was not bound to it.`,
          EXIT_CODES.unsafe
        );
      }
      onPrepared(result);
    }
    return result;
  };
  return withStateLock(
    opening.repository.commonGitDirectory,
    "prepare agent worktree",
    () => {
      let inventory = captureInventory(repositoryPath);
      const lease = requireLease(inventory);
      assertMatchingRun(lease, runId);
      assertControllerActive(lease);
      assertShipmentScopeRecorded(lease);
      assertLegacyRunAllowsMutation(
        lease,
        inventory,
        "This legacy run has no opening remote inventory and cannot prepare new authoring work; use close-only post-cleanup recovery. Next: run `simple-changes loop recover-post-cleanup` when cleanup is already complete, or `simple-changes loop close-equivalent` when the work is already contained in the target."
      );
      const bindings = readChangelogAuthors(lease);
      const binding = bindings.find((item) => item.agentId === agentId);
      const existing = lease.worktrees.find(
        (worktree) => worktree.agentId === agentId
      );
      if (existing) {
        assertChangelogBinding(agentId, unitId, binding, existing.path);
        return prepared(
          reusedRegistration(lease, inventory, existing, binding)
        );
      }

      const finalizePreparation = (
        currentLease: LoopLease,
        preparation: LoopWorktreePreparation
      ): PreparedAgentWorktree => {
        inventory = captureInventory(repositoryPath);
        const preparedPath = existsSync(preparation.path)
          ? realpathSync(preparation.path)
          : preparation.path;
        const createdWorktree = inventory.worktrees.find(
          (worktree) => worktree.path === preparedPath
        );
        if (
          !createdWorktree ||
          createdWorktree.branch !== preparation.branch ||
          createdWorktree.headSha !== preparation.baseRevision
        ) {
          throw new SimpleChangesError(
            `Agent worktree preparation at ${preparation.path} is incomplete or no longer matches branch ${preparation.branch} at ${preparation.baseRevision}. Resume only after restoring that exact state.`,
            EXIT_CODES.unsafe
          );
        }
        if (createdWorktree.changes.length > 0) {
          throw new SimpleChangesError(
            `Agent worktree preparation at ${preparation.path} contains staged, unstaged, or untracked changes. Preserve it for inspection; only a clean interrupted preparation may be registered.`,
            EXIT_CODES.unsafe
          );
        }
        const completedAt = new Date().toISOString();
        const completedLease: LoopLease = {
          ...withMutationEvidence(currentLease, completedAt),
          preparations: currentLease.preparations.filter(
            (item) => item.agentId !== preparation.agentId
          ),
          updatedAt: completedAt,
          worktrees: [
            ...currentLease.worktrees,
            exactWorktreeLease(createdWorktree, "author", agentId, true),
          ],
        };
        writeLease(completedLease);
        const closingVerification = verificationAgainst(
          completedLease,
          inventory
        );
        if (!closingVerification.ok) {
          throw new SimpleChangesError(
            `Agent worktree registered, but concurrent manifest violations now block mutation: ${closingVerification.violations
              .map((violation) => `${violation.code}:${violation.path}`)
              .join(", ")}`,
            EXIT_CODES.unsafe
          );
        }
        return prepared({
          agentId,
          baseRevision: preparation.baseRevision,
          branch: preparation.branch,
          created: true,
          path: createdWorktree.path,
          runId: currentLease.runId,
          ...changelogAuthorReport(
            readChangelogAuthors(currentLease).find(
              (item) =>
                item.agentId === agentId && item.path === preparation.path
            )
          ),
        });
      };

      const resumePreparation = (
        currentLease: LoopLease,
        preparation: LoopWorktreePreparation
      ): PreparedAgentWorktree => {
        // A new preparation's branch is built from slugs, so it is always
        // exact; one an older runtime recorded is checked before Git runs.
        assertExactBranch(
          preparation.branch,
          `the loop registration of ${preparation.path}`
        );
        const preparedPath = existsSync(preparation.path)
          ? realpathSync(preparation.path)
          : preparation.path;
        const currentWorktree = inventory.worktrees.find(
          (worktree) => worktree.path === preparedPath
        );
        if (currentWorktree) {
          return finalizePreparation(currentLease, preparation);
        }
        if (pathEntryExists(preparation.path)) {
          throw new SimpleChangesError(
            `Prepared path ${preparation.path} exists but is not the registered Git worktree. Preserve it for inspection.`,
            EXIT_CODES.unsafe
          );
        }
        const branchResult = runGit(
          currentLease.primaryCheckout,
          [
            "rev-parse",
            "--verify",
            `refs/heads/${preparation.branch}^{commit}`,
          ],
          true
        );
        const branchRevision = branchResult.stdout.trim();
        if (
          branchResult.exitCode === 0 &&
          branchRevision !== preparation.baseRevision
        ) {
          throw new SimpleChangesError(
            `Prepared branch ${preparation.branch} moved to ${branchRevision}; expected ${preparation.baseRevision}.`,
            EXIT_CODES.unsafe
          );
        }
        // `git worktree add` creates any missing parent folders, and Simple
        // Changes never creates one: a new preparation sits beside the
        // primary checkout, whose folder exists. A preparation recorded in
        // the older managed layout resumes only while its folder still exists.
        const parent = dirname(preparation.path);
        if (!isDirectory(parent)) {
          throw new SimpleChangesError(
            `The folder ${parent} that holds prepared path ${preparation.path} is missing or is not a directory, and Simple Changes never creates a worktree's parent folder. Restore that folder, then run the same command again.`,
            EXIT_CODES.unsafe
          );
        }
        if (branchResult.exitCode === 0) {
          runGit(currentLease.primaryCheckout, [
            "worktree",
            "add",
            preparation.path,
            preparation.branch,
          ]);
        } else {
          runGit(currentLease.primaryCheckout, [
            "worktree",
            "add",
            "-b",
            preparation.branch,
            preparation.path,
            preparation.baseRevision,
          ]);
        }
        return finalizePreparation(currentLease, preparation);
      };

      const pending = lease.preparations.find(
        (preparation) => preparation.agentId === agentId
      );
      if (pending) {
        assertChangelogBinding(agentId, unitId, binding, pending.path);
        return resumePreparation(lease, pending);
      }
      const releaseSurfaces = newAuthorReleaseSurfaces(lease, unitId, purpose);
      const verification = verificationAgainst(lease, inventory);
      if (!verification.ok) {
        throw new SimpleChangesError(
          `Cannot prepare an agent worktree while the loop manifest has violations: ${verification.violations
            .map((violation) => `${violation.code}:${violation.path}`)
            .join(", ")}`,
          EXIT_CODES.unsafe
        );
      }
      const agentSlug = slug(agentId, "agent");
      const runSlug = lease.runId.slice(4, 16);
      const branch = `simple-changes/${purpose}-${agentSlug}-${runSlug}`;
      const path = preparedWorktreePath(lease.primaryCheckout, {
        agent: agentSlug,
        purpose,
        run: runSlug,
      });
      if (pathEntryExists(path)) {
        throw new SimpleChangesError(
          `Refusing to reuse unregistered agent worktree path ${path}.`,
          EXIT_CODES.unsafe
        );
      }
      const branchExists =
        runGit(
          lease.primaryCheckout,
          ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
          true
        ).exitCode === 0;
      if (branchExists) {
        throw new SimpleChangesError(
          `Refusing to reuse unregistered agent branch ${branch}.`,
          EXIT_CODES.unsafe
        );
      }
      const baseRevision = lease.targetRevision;
      const newPreparation: LoopWorktreePreparation = {
        agentId,
        baseRevision,
        branch,
        createdAt: new Date().toISOString(),
        path,
        purpose,
      };
      bindChangelogAuthor(
        lease,
        bindings,
        newPreparation,
        releaseSurfaces !== null && unitId !== null
          ? { releaseSurfaces, unitId }
          : null
      );
      const preparingLease = writeLease({
        ...withMutationEvidence(lease, newPreparation.createdAt),
        preparations: [...lease.preparations, newPreparation],
        updatedAt: newPreparation.createdAt,
      });
      return resumePreparation(preparingLease, newPreparation);
    }
  );
};

interface WorktreeRemovalAudit {
  containmentMethod: TargetContainmentMethod;
  current: WorktreeInventory & { headSha: string };
  path: string;
  targetRevision: string;
}

interface CleanWorktreeAuditMessages {
  digestLabel: string;
  dirty: (path: string) => string;
  isRegistered: (path: string) => boolean;
  missing: (path: string) => string;
  missingHead: (path: string) => string;
  primary: string;
}

const auditCleanNonPrimaryWorktree = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  pathInput: string,
  changeDigest: string,
  messages: CleanWorktreeAuditMessages
): { current: WorktreeInventory & { headSha: string }; path: string } => {
  const path = existsSync(pathInput)
    ? realpathSync(pathInput)
    : resolve(pathInput);
  if (path === lease.primaryCheckout) {
    throw new SimpleChangesError(messages.primary, EXIT_CODES.unsafe);
  }
  const current = inventory.worktrees.find(
    (worktree) => worktree.path === path
  );
  if (!(current && messages.isRegistered(path))) {
    throw new SimpleChangesError(messages.missing(path), EXIT_CODES.unsafe);
  }
  if (current.changeDigest !== changeDigest) {
    throw new SimpleChangesError(
      `${messages.digestLabel} digest does not match ${path}; expected current digest ${current.changeDigest}.`,
      EXIT_CODES.unsafe
    );
  }
  if (current.changes.length > 0) {
    throw new SimpleChangesError(messages.dirty(path), EXIT_CODES.unsafe);
  }
  if (!current.headSha) {
    throw new SimpleChangesError(messages.missingHead(path), EXIT_CODES.unsafe);
  }
  return { current: current as WorktreeInventory & { headSha: string }, path };
};

const auditWorktreeRemoval = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  pathInput: string,
  changeDigest: string
): WorktreeRemovalAudit => {
  const { current, path } = auditCleanNonPrimaryWorktree(
    lease,
    inventory,
    pathInput,
    changeDigest,
    {
      digestLabel: "Disposition",
      dirty: (candidate) =>
        `Opening worktree ${candidate} must be clean before removal can be authorized.`,
      isRegistered: (candidate) =>
        lease.worktrees.some(
          (worktree) =>
            worktree.path === candidate &&
            worktree.role === "preserved" &&
            !worktree.createdByRun
        ),
      missing: (candidate) =>
        `Disposition path must name a current preserved worktree (one registered at loop start, or adopted through adopt-worktree or accept-paused-change): ${candidate}`,
      missingHead: (candidate) =>
        `Opening worktree ${candidate} has no auditable HEAD revision.`,
      primary:
        "The canonical primary checkout cannot be disposed by the active loop.",
    }
  );
  const targetRevision = currentTargetRevision(lease);
  const targetDescendsFromPinned =
    runGit(
      lease.primaryCheckout,
      [
        "merge-base",
        "--is-ancestor",
        `${lease.targetRevision}^{commit}`,
        `${targetRevision}^{commit}`,
      ],
      true
    ).exitCode === 0;
  if (!targetDescendsFromPinned) {
    throw new SimpleChangesError(
      `Refreshed target ${targetRevision} does not descend from pinned target ${lease.targetRevision}.`,
      EXIT_CODES.unsafe
    );
  }
  const uniqueCommitCount = Number.parseInt(
    runGit(lease.primaryCheckout, [
      "rev-list",
      "--count",
      `${targetRevision}..${current.headSha}`,
    ]).stdout.trim(),
    10
  );
  let containmentMethod: TargetContainmentMethod = "target-contained";
  if (!(Number.isInteger(uniqueCommitCount) && uniqueCommitCount === 0)) {
    const containment = targetContainmentAudit(
      lease.primaryCheckout,
      targetRevision,
      current.headSha
    );
    if (containment.exceededMaxCommits) {
      throw new SimpleChangesError(
        `Worktree ${path} is more than ${PATCH_EQUIVALENCE_MAX_COMMITS} commits ahead of ${lease.targetRef}; the patch-equivalence audit was skipped. Next: ship or preserve that work instead of disposing the worktree.`,
        EXIT_CODES.unsafe
      );
    }
    if (containment.method !== "patch-equivalent") {
      throw new SimpleChangesError(
        `Worktree ${path} has ${uniqueCommitCount} unique commit(s) outside ${lease.targetRef} at ${targetRevision}, and they are not patch-equivalent to commits already in the target. Next: ship or preserve that work instead of disposing the worktree.`,
        EXIT_CODES.unsafe
      );
    }
    containmentMethod = "patch-equivalent";
  }
  return { containmentMethod, current, path, targetRevision };
};

const validatedWorktreeDispositionInputs = (
  ownerAgentIdInput: string,
  changeDigestInput: string,
  approvedByInput: string,
  reasonInput: string,
  reasonName: string
): {
  approvedBy: string;
  changeDigest: string;
  ownerAgentId: string;
  reason: string;
} => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const approvedBy = requiredText(approvedByInput, "approved-by identity");
  const reason = requiredText(reasonInput, reasonName);
  const changeDigest = requiredText(changeDigestInput, "status digest");
  if (!DIGEST_PATTERN.test(changeDigest)) {
    throw new SimpleChangesError(
      "status digest must be a 64-character lowercase SHA-256 value.",
      EXIT_CODES.usage
    );
  }
  return { approvedBy, changeDigest, ownerAgentId, reason };
};

export const authorizeWorktreeRemoval = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string,
  pathInput: string,
  changeDigestInput: string,
  approvedByInput: string,
  reasonInput: string
): LoopLease => {
  const { approvedBy, changeDigest, ownerAgentId, reason } =
    validatedWorktreeDispositionInputs(
      ownerAgentIdInput,
      changeDigestInput,
      approvedByInput,
      reasonInput,
      "disposition reason"
    );
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "authorize opening worktree removal",
    () => {
      const { inventory, lease } = requireOwnedLease(
        repositoryPath,
        runId,
        ownerAgentId,
        "record a worktree disposition"
      );
      assertControllerActive(lease);
      const { containmentMethod, current, path, targetRevision } =
        auditWorktreeRemoval(lease, inventory, pathInput, changeDigest);
      assertExactBranch(current.branch, `the removal disposition of ${path}`);
      const disposition: LoopWorktreeDisposition = {
        approvedBy,
        branch: current.branch,
        changeDigest,
        containmentMethod,
        createdAt: new Date().toISOString(),
        headSha: current.headSha,
        outcome: "remove-after-audit",
        path,
        reason,
        targetRef: lease.targetRef,
        targetRevision,
        uniqueCommitCount: 0,
      };
      const candidate: LoopLease = {
        ...lease,
        dispositions: [
          ...(lease.dispositions ?? []).filter((item) => item.path !== path),
          disposition,
        ],
        updatedAt: disposition.createdAt,
      };
      const verification = verificationAgainst(candidate, inventory);
      if (!verification.ok) {
        throw new SimpleChangesError(
          `Worktree disposition is exact but other loop violations remain: ${verification.violations
            .map((violation) => `${violation.code}:${violation.path}`)
            .join(", ")}`,
          EXIT_CODES.unsafe
        );
      }
      return writeLease(withMutationEvidence(candidate, candidate.updatedAt));
    }
  );
};

const auditWorktreeRetention = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  pathInput: string,
  changeDigest: string
): { current: WorktreeInventory & { headSha: string }; path: string } => {
  const { current, path } = auditCleanNonPrimaryWorktree(
    lease,
    inventory,
    pathInput,
    changeDigest,
    {
      digestLabel: "Retention",
      dirty: (candidate) =>
        `Worktree ${candidate} is changing or dirty; its owner must claim it as an active concurrent author or pause it before it can be excluded from this shipment.`,
      isRegistered: () => true,
      missing: (candidate) =>
        `Retention path must name a current worktree: ${candidate}`,
      missingHead: (candidate) =>
        `Worktree ${candidate} has no auditable HEAD revision.`,
      primary:
        "The canonical primary checkout cannot be retained as excluded concurrent state.",
    }
  );
  const registered = lease.worktrees.find((worktree) => worktree.path === path);
  if (
    registered &&
    registered.role !== "preserved" &&
    registered.role !== "retained"
  ) {
    throw new SimpleChangesError(
      `Worktree ${path} is already registered as ${registered.role}; it cannot also be retained as excluded state.`,
      EXIT_CODES.unsafe
    );
  }
  const targetRevision = currentTargetRevision(lease);
  const targetContainsHead =
    runGit(
      lease.primaryCheckout,
      [
        "merge-base",
        "--is-ancestor",
        `${current.headSha}^{commit}`,
        `${targetRevision}^{commit}`,
      ],
      true
    ).exitCode === 0;
  if (!targetContainsHead) {
    throw new SimpleChangesError(
      `Worktree ${path} has commits outside ${lease.targetRef}; preserve and inspect that work instead of marking it as an unchanged cleanup exclusion.`,
      EXIT_CODES.unsafe
    );
  }
  return { current, path };
};

export const retainExcludedWorktree = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string,
  pathInput: string,
  changeDigestInput: string,
  approvedByInput: string,
  reasonInput: string
): LoopLease => {
  const { approvedBy, changeDigest, ownerAgentId, reason } =
    validatedWorktreeDispositionInputs(
      ownerAgentIdInput,
      changeDigestInput,
      approvedByInput,
      reasonInput,
      "retention reason"
    );
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "retain excluded worktree",
    () => {
      const { inventory, lease } = requireOwnedLease(
        repositoryPath,
        runId,
        ownerAgentId,
        "retain an excluded worktree"
      );
      assertControllerActive(lease);
      const { current, path } = auditWorktreeRetention(
        lease,
        inventory,
        pathInput,
        changeDigest
      );
      const createdAt = new Date().toISOString();
      const retained: LoopWorktreeLease = {
        ...exactWorktreeLease(current, "retained", null, false),
        retention: { approvedBy, createdAt, reason },
      };
      const candidate: LoopLease = {
        ...lease,
        updatedAt: createdAt,
        worktrees: [
          ...lease.worktrees.filter((worktree) => worktree.path !== path),
          retained,
        ],
      };
      const pathViolation = verificationAgainst(
        candidate,
        inventory
      ).violations.find((violation) => violation.path === path);
      if (pathViolation) {
        throw new SimpleChangesError(
          `Could not retain ${path}: ${pathViolation.message}`,
          EXIT_CODES.unsafe
        );
      }
      return writeLease(withMutationEvidence(candidate, candidate.updatedAt));
    }
  );
};

export const grantLoopOverride = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string,
  pathInput: string,
  changeDigestInput: string,
  approvedByInput: string,
  reasonInput: string
): LoopLease => {
  const { approvedBy, changeDigest, ownerAgentId, reason } =
    validatedWorktreeDispositionInputs(
      ownerAgentIdInput,
      changeDigestInput,
      approvedByInput,
      reasonInput,
      "override reason"
    );
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop allow",
    () => {
      const { inventory, lease } = requireOwnedLease(
        repositoryPath,
        runId,
        ownerAgentId,
        "record an override"
      );
      assertControllerActive(lease);
      const path = existsSync(pathInput)
        ? realpathSync(pathInput)
        : resolve(pathInput);
      const registered = lease.worktrees.find(
        (worktree) => worktree.path === path && worktree.role === "preserved"
      );
      const concurrentAuthor = lease.worktrees.find(
        (worktree) =>
          worktree.path === path && worktree.role === "concurrent-author"
      );
      const current = inventory.worktrees.find(
        (worktree) => worktree.path === path
      );
      if (concurrentAuthor) {
        throw new SimpleChangesError(
          `Worktree ${path} is already recognized as an actively claimed concurrent author; no user-approved override is allowed or needed.`,
          EXIT_CODES.unsafe
        );
      }
      if (!(registered && current)) {
        throw new SimpleChangesError(
          `Override path must name a current preserved baseline worktree: ${path}`,
          EXIT_CODES.unsafe
        );
      }
      if (current.changeDigest !== changeDigest) {
        throw new SimpleChangesError(
          `Override digest does not match ${path}; expected current digest ${current.changeDigest}.`,
          EXIT_CODES.unsafe
        );
      }
      const override: LoopOverride = {
        approvedBy,
        changeDigest,
        createdAt: new Date().toISOString(),
        headSha: current.headSha,
        path,
        reason,
      };
      const candidate = {
        ...lease,
        overrides: [
          ...lease.overrides.filter((item) => item.path !== path),
          override,
        ],
        updatedAt: override.createdAt,
      };
      const pathViolation = verificationAgainst(
        candidate,
        inventory
      ).violations.find((violation) => violation.path === path);
      if (pathViolation) {
        throw new SimpleChangesError(
          `Override does not resolve ${path}: ${pathViolation.message}`,
          EXIT_CODES.unsafe
        );
      }
      return writeLease(withMutationEvidence(candidate, candidate.updatedAt));
    }
  );
};

export const markWorktreeResumeReady = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string,
  claimIdInput: string
): {
  claimId: string;
  lease: LoopLease;
  targetRef: string;
  targetSha: string;
} => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const claimId = requiredText(claimIdInput, "claim ID");
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "worktree resume-ready",
    () => {
      const { inventory, lease } = requireOwnedLease(
        repositoryPath,
        runId,
        ownerAgentId,
        "mark a worktree resume-ready"
      );
      assertControllerActive(lease);
      const verification = verificationAgainst(lease, inventory);
      if (!verification.ok) {
        throw new SimpleChangesError(
          `Cannot mark resume-ready while manifest violations remain: ${verification.violations
            .map((violation) => `${violation.code}:${violation.path}`)
            .join(", ")}`,
          EXIT_CODES.unsafe
        );
      }
      const targetSha = runGit(lease.primaryCheckout, [
        "rev-parse",
        "--verify",
        `${lease.targetRef}^{commit}`,
      ]).stdout.trim();
      markCoordinationResumeReady(
        lease.commonGitDirectory,
        claimId,
        ownerAgentId,
        lease.runId,
        lease.targetRef,
        targetSha
      );
      const candidate: LoopLease = {
        ...lease,
        updatedAt: new Date().toISOString(),
        worktrees: lease.worktrees.map((worktree) =>
          worktree.claimId === claimId
            ? { ...worktree, coordinationState: "resume-ready" as const }
            : worktree
        ),
      };
      return {
        claimId,
        lease: writeLease(withMutationEvidence(candidate, candidate.updatedAt)),
        targetRef: lease.targetRef,
        targetSha,
      };
    }
  );
};
