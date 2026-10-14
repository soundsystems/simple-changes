import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  PATCH_EQUIVALENCE_MAX_COMMITS,
  type TargetContainmentMethod,
  targetContainmentAudit,
} from "./cleanup-core.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { captureInventory, locateRepository } from "./inventory.ts";
import {
  assertControllerActive,
  assertMatchingRun,
  assertNewAuthorPreparationAllowed,
  assertShipmentScopeRecorded,
  currentTargetRevision,
  DIGEST_PATTERN,
  readLeaseFromCommonDirectory,
  requiredText,
  requireLease,
  requireOwnedLease,
  targetUsesGitLab,
  withMutationEvidence,
  withStateLock,
  worktreeLease,
  writeLease,
} from "./loop-lease-core.ts";
import { verificationAgainst } from "./loop-lease-verify.ts";
import { runGit } from "./process.ts";
import type {
  LoopLease,
  LoopOverride,
  LoopWorktreeDisposition,
  LoopWorktreeLease,
  LoopWorktreePreparation,
  RepositoryInventory,
  WorktreeInventory,
} from "./types.ts";
import { markCoordinationResumeReady } from "./worktree-coordination.ts";

const slug = (value: string, fallback: string): string => {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return normalized || fallback;
};

const assertLegacyRunAllowsMutation = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  message: string
): void => {
  if (targetUsesGitLab(inventory) && !lease.openingRemoteInventory) {
    throw new SimpleChangesError(message, EXIT_CODES.unsafe);
  }
};

export interface PreparedAgentWorktree {
  agentId: string;
  baseRevision: string;
  branch: string;
  created: boolean;
  path: string;
  runId: string;
}

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
  onPrepared?: (prepared: PreparedAgentWorktree) => void
): PreparedAgentWorktree => {
  const agentId = requiredText(agentIdInput, "agent ID");
  const purpose = slug(requiredText(purposeInput, "purpose"), "work");
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
      const existing = lease.worktrees.find(
        (worktree) => worktree.agentId === agentId
      );
      if (existing) {
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
        return prepared({
          agentId,
          baseRevision: existing.baselineHeadSha ?? lease.targetRevision,
          branch: existing.branch,
          created: false,
          path: existing.path,
          runId: lease.runId,
        });
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
            worktreeLease(createdWorktree, "author", agentId, true),
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
        });
      };

      const resumePreparation = (
        currentLease: LoopLease,
        preparation: LoopWorktreePreparation
      ): PreparedAgentWorktree => {
        const preparedPath = existsSync(preparation.path)
          ? realpathSync(preparation.path)
          : preparation.path;
        const currentWorktree = inventory.worktrees.find(
          (worktree) => worktree.path === preparedPath
        );
        if (currentWorktree) {
          return finalizePreparation(currentLease, preparation);
        }
        if (existsSync(preparation.path)) {
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
        mkdirSync(dirname(preparation.path), { recursive: true });
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
        return resumePreparation(lease, pending);
      }
      assertNewAuthorPreparationAllowed(lease);
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
      const repositorySlug = slug(
        basename(lease.primaryCheckout),
        "repository"
      );
      const branch = `simple-changes/${purpose}-${agentSlug}-${runSlug}`;
      const path = resolve(
        dirname(lease.primaryCheckout),
        ".simple-changes-worktrees",
        repositorySlug,
        `${runSlug}-${purpose}-${agentSlug}`
      );
      if (existsSync(path)) {
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
        ...worktreeLease(current, "retained", null, false),
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
