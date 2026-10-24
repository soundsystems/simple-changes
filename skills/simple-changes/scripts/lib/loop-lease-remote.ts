import {
  PATCH_EQUIVALENCE_MAX_COMMITS,
  targetContainmentAudit,
  targetContainsRevision,
} from "./cleanup-core.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { locateRepository } from "./inventory.ts";
import {
  assertControllerActive,
  currentTargetRevision,
  gitLabProjectForTargetRef,
  MISSING_OPENING_REMOTE_INVENTORY_BLOCKER,
  MISSING_REMOTE_RECONCILIATION_BLOCKER,
  ownerProcessEvidence,
  REMOTE_BRANCH_ANCESTRY_DIRECTORY,
  REMOTE_BRANCH_EXTERNAL_DELETIONS_DIRECTORY,
  REMOTE_BRANCH_OPEN_TARGETS_DIRECTORY,
  REMOTE_BRANCH_SUPERSESSION_DIRECTORY,
  REMOTE_RECONCILIATION_MODES,
  readReceiptSidecar,
  requiredRunId,
  requiredText,
  requireOwnedLease,
  targetBranchForRef,
  targetUsesGitLab,
  withMutationEvidence,
  withStateLock,
  writeLease,
  writeReceiptSidecar,
} from "./loop-lease-core.ts";
import { verificationAgainst } from "./loop-lease-verify.ts";
import { runGit } from "./process.ts";
import {
  EXTERNAL_DELETION_PIN_RETENTION_MS,
  type ExternalDeletionPin,
  externalDeletionPinRef,
  listExternalDeletionPins,
  liveExternalDeletionPin,
} from "./remote-branch-prune.ts";
import {
  externalDeletionsForReceipt,
  isExternalDeletionShape,
  openProposalTargetsForReceipt,
  remoteBranchReconciliationDigest,
  remoteInventoryDigest,
  splitRemoteBranchReconciliationInput,
  validateRemoteBranchAncestryRecord,
  validateRemoteBranchReconciliation,
  validateRemoteBranchSupersessionRecord,
} from "./remote-branch-reconciliation.ts";
import { validateSchema } from "./schema.ts";
import type {
  LoopLease,
  RemoteBranchAncestryProof,
  RemoteBranchAncestryRecord,
  RemoteBranchExternalDeletion,
  RemoteBranchExternalDeletionRecord,
  RemoteBranchOpenProposalTarget,
  RemoteBranchOpenTargetsRecord,
  RemoteBranchReconciliationEntry,
  RemoteBranchReconciliationReceipt,
  RemoteBranchSupersession,
  RemoteBranchSupersessionRecord,
  RepositoryInventory,
} from "./types.ts";

/**
 * Merged-head ancestry proofs live beside the lease, never inside it: older
 * clients strictly validate the lease, so the embedded receipt keeps the
 * original schema. The sidecar is replaced or removed under the state lock
 * whenever a receipt is recorded, and is kept afterward as audit evidence.
 */
const writeRemoteBranchAncestry = (
  lease: LoopLease,
  receipt: RemoteBranchReconciliationReceipt,
  proofs: RemoteBranchAncestryProof[]
): void =>
  writeReceiptSidecar(
    lease,
    REMOTE_BRANCH_ANCESTRY_DIRECTORY,
    proofs.length === 0
      ? null
      : validateSchema<RemoteBranchAncestryRecord>("remote-branch-ancestry", {
          proofs,
          receiptDigest: remoteBranchReconciliationDigest(receipt),
          runId: lease.runId,
          schemaVersion: 1,
        })
  );

/**
 * Supersession approvals follow the ancestry sidecar's rules: beside the
 * lease, bound to the exact receipt digest, replaced or removed whenever a
 * receipt is recorded, and kept afterward as audit evidence.
 */
const writeRemoteBranchSupersession = (
  lease: LoopLease,
  receipt: RemoteBranchReconciliationReceipt,
  supersessions: RemoteBranchSupersession[]
): void =>
  writeReceiptSidecar(
    lease,
    REMOTE_BRANCH_SUPERSESSION_DIRECTORY,
    supersessions.length === 0
      ? null
      : validateSchema<RemoteBranchSupersessionRecord>(
          "remote-branch-supersession",
          {
            receiptDigest: remoteBranchReconciliationDigest(receipt),
            runId: lease.runId,
            schemaVersion: 1,
            supersessions,
          }
        )
  );

/**
 * Open proposal targets follow the same sidecar rules. They only narrow the
 * cleanup report `loop finalize` writes, so a missing or mismatched record
 * reads as unknown targets, which reports more branches as pending, not fewer.
 */
const writeRemoteBranchOpenTargets = (
  lease: LoopLease,
  receipt: RemoteBranchReconciliationReceipt,
  targets: RemoteBranchOpenProposalTarget[] | null
): void =>
  writeReceiptSidecar(
    lease,
    REMOTE_BRANCH_OPEN_TARGETS_DIRECTORY,
    targets === null
      ? null
      : validateSchema<RemoteBranchOpenTargetsRecord>(
          "remote-branch-open-targets",
          {
            openProposalTargets: targets,
            receiptDigest: remoteBranchReconciliationDigest(receipt),
            runId: lease.runId,
            schemaVersion: 1,
          }
        )
  );

/**
 * Pins the last head of each branch deleted outside the run, when Git has it
 * and no pin of this run already keeps it, at
 * `refs/simple-changes/external/<runId>/<head>/<ms>`, so gc cannot remove
 * the work while the user decides. The pin's time is in its name, so a pin
 * that exists always has a known age and a failed one leaves nothing. A head
 * that is not present locally is reported later, unpinned; it never stops
 * the record.
 */
const pinExternallyDeletedHeads = (
  repositoryPath: string,
  runId: string,
  deletions: readonly RemoteBranchExternalDeletion[]
): void => {
  for (const { branch, lastHeadRevision } of deletions) {
    if (
      liveExternalDeletionPin(repositoryPath, runId, lastHeadRevision) ||
      runGit(
        repositoryPath,
        ["cat-file", "-e", `${lastHeadRevision}^{commit}`],
        true
      ).exitCode !== 0
    ) {
      continue;
    }
    const pinned = runGit(
      repositoryPath,
      [
        "update-ref",
        "-m",
        `simple-changes: pin ${branch}, deleted outside ${runId}`,
        externalDeletionPinRef(runId, lastHeadRevision, Date.now()),
        lastHeadRevision,
      ],
      true
    );
    if (pinned.exitCode !== 0) {
      throw new SimpleChangesError(
        `Could not pin last head ${lastHeadRevision} of ${branch}, which was deleted outside this run: ${pinned.stderr.trim()}. The reconciliation was not recorded; fix the Git error and record the final reconciliation again.`,
        EXIT_CODES.unsafe
      );
    }
  }
};

/**
 * Branches deleted outside the run live beside the lease, one immutable file
 * per receipt, named by its digest. A record writes only its own receipt's
 * file and never reads, rewrites, or removes another, so a record that fails
 * or is interrupted before the lease write cannot take evidence away from the
 * receipt the lease already holds.
 */
const writeRemoteBranchExternalDeletions = (
  lease: LoopLease,
  receipt: RemoteBranchReconciliationReceipt,
  deletions: RemoteBranchExternalDeletion[]
): void => {
  if (deletions.length === 0) {
    return;
  }
  const receiptDigest = remoteBranchReconciliationDigest(receipt);
  writeReceiptSidecar(
    lease,
    REMOTE_BRANCH_EXTERNAL_DELETIONS_DIRECTORY,
    validateSchema<RemoteBranchExternalDeletionRecord>(
      "remote-branch-external-deletions",
      { deletions, receiptDigest, runId: lease.runId, schemaVersion: 1 }
    ),
    receiptDigest
  );
};

export interface ExpiredExternalDeletionPins {
  errors: string[];
  removed: string[];
}

/**
 * Removes pins of branches deleted outside earlier runs once their retention
 * has passed. It reads only refs: a ref of exactly the shape this module makes
 * whose value is its own head, from a run other than `currentRunId`, made
 * more than the retention ago by the time in its name. Each removal names the
 * exact old value, so a ref that changed meanwhile is kept.
 */
export const pruneExpiredExternalDeletionPins = (
  repositoryPath: string,
  currentRunId: string,
  now: number = Date.now()
): ExpiredExternalDeletionPins => {
  const result: ExpiredExternalDeletionPins = { errors: [], removed: [] };
  let pins: ExternalDeletionPin[];
  try {
    pins = listExternalDeletionPins(repositoryPath);
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    return result;
  }
  for (const pin of pins) {
    if (
      pin.runId === currentRunId ||
      now - pin.pinnedAtMs < EXTERNAL_DELETION_PIN_RETENTION_MS
    ) {
      continue;
    }
    const removal = runGit(
      repositoryPath,
      ["update-ref", "-d", pin.ref, pin.head],
      true
    );
    if (removal.exitCode === 0) {
      result.removed.push(pin.ref);
    } else {
      result.errors.push(
        `Could not remove expired pin ${pin.ref}: ${removal.stderr.trim() || `exit ${removal.exitCode}`}`
      );
    }
  }
  return result;
};

/** The open proposal targets recorded with the lease's receipt, or null. */
export const recordedOpenProposalTargets = (
  lease: LoopLease
): RemoteBranchOpenProposalTarget[] | null => {
  const receipt = lease.remoteBranchReconciliation;
  if (!receipt) {
    return null;
  }
  let stored: unknown = null;
  try {
    stored = readReceiptSidecar(
      lease.commonGitDirectory,
      REMOTE_BRANCH_OPEN_TARGETS_DIRECTORY,
      lease.runId
    );
  } catch {
    return null;
  }
  return openProposalTargetsForReceipt(stored, lease.runId, receipt);
};

/**
 * The receipt validator is pure, so an ancestry proof is only a claim until
 * git confirms the initial head is the merged head or its ancestor and the
 * target contains the merged head. A branch whose proposal was open at the
 * opening inventory and merged at that unchanged head needs no sidecar, but
 * git must still find the head in the target, so a squash merge or a merge
 * into another branch fails closed exactly as with a sidecar. Missing objects
 * fail closed.
 */
const assertRemoteBranchAncestry = (
  repositoryPath: string,
  receipt: RemoteBranchReconciliationReceipt,
  proofs: readonly RemoteBranchAncestryProof[]
): void => {
  const proven = new Set(proofs.map((proof) => proof.branch));
  for (const branch of receipt.branches) {
    const openedBeforeMerge =
      branch.disposition === "deleted-merged" &&
      branch.obsoleteProof === "merged-proposal-head" &&
      !proven.has(branch.name) &&
      branch.proposals.some(
        (proposal) =>
          proposal.state === "open" && proposal.observedFinally === false
      );
    if (
      openedBeforeMerge &&
      branch.initialHeadRevision &&
      !targetContainsRevision(
        repositoryPath,
        receipt.targetRevision,
        branch.initialHeadRevision
      )
    ) {
      throw new SimpleChangesError(
        `Merged deletion of ${branch.name} is not verified: its proposal was open at the opening inventory, and merged head ${branch.initialHeadRevision} is not contained in target ${receipt.targetRevision} (for example after a squash merge or a merge into another branch). Report the branch, head, and proposal to the user; this receipt cannot be recorded.`,
        EXIT_CODES.unsafe
      );
    }
  }
  for (const proof of proofs) {
    const reportable = `Report branch ${proof.branch}, initial head ${proof.initialHeadRevision}, and proposal ${proof.proposalObjectId} to the user; this receipt cannot be recorded.`;
    if (
      !targetContainsRevision(
        repositoryPath,
        proof.mergedHeadRevision,
        proof.initialHeadRevision
      )
    ) {
      throw new SimpleChangesError(
        `Merged-head ancestry proof for ${proof.branch} is not verified: initial head ${proof.initialHeadRevision} is not the merged head ${proof.mergedHeadRevision} or a local ancestor of it (rewritten, force-pushed, or GitLab-rebased history, or missing objects). ${reportable}`,
        EXIT_CODES.unsafe
      );
    }
    if (
      !targetContainsRevision(
        repositoryPath,
        receipt.targetRevision,
        proof.mergedHeadRevision
      )
    ) {
      throw new SimpleChangesError(
        `Merged-head ancestry proof for ${proof.branch} is not verified: merged head ${proof.mergedHeadRevision} is not contained in target ${receipt.targetRevision} (for example after a squash merge). ${reportable}`,
        EXIT_CODES.unsafe
      );
    }
  }
};

// Lets a test fail a record after its sidecars are written and before the
// lease is, as an interrupted or failed lease write would.
const failBeforeReconciliationLeaseWriteForTest = (): void => {
  if (
    process.env.NODE_ENV === "test" &&
    process.env.SIMPLE_CHANGES_TEST_FAIL_BEFORE_RECONCILIATION_LEASE_WRITE ===
      "1"
  ) {
    throw new SimpleChangesError(
      "Test failure before the reconciliation lease write.",
      EXIT_CODES.unsafe
    );
  }
};

const SUPERSEDED_HEAD_REF_PREFIX = "refs/simple-changes/superseded/";

const supersededHeadRef = (runId: string, head: string): string =>
  `${SUPERSEDED_HEAD_REF_PREFIX}${requiredRunId(runId)}/${head}`;

/**
 * A supersession approval is a user's judgment, but its facts are Git's: the
 * deleted head must still exist locally (so the work stays auditable and
 * restorable) and lie outside the target (otherwise target-contains-head is
 * the proof to record), and every replacement must be in the target without
 * being an ancestor of the deleted head, so the shared fork point can never be
 * named as the replacement. That last check is negative, so a shallow clone,
 * whose boundary commits hide their parents, or a head with no history shared
 * with the target would pass it falsely; both fail closed. Missing objects fail
 * closed.
 *
 * Whether the approval is unnecessary is a tidiness check, not a safety one.
 * Where the receipt is recorded it uses the same containment audit as
 * target-contains-head, so the two can never disagree; at loop end it stays the
 * cheap exact-ancestry check older clients recorded against, so a run recorded
 * by 0.22.3 still ends.
 */
const assertRemoteBranchSupersession = (
  repositoryPath: string,
  receipt: RemoteBranchReconciliationReceipt,
  supersessions: readonly RemoteBranchSupersession[],
  check:
    | { phase: "record"; targetPatchIdCache: Map<string, Map<string, string>> }
    | { phase: "loop-end" }
): void => {
  if (
    supersessions.length > 0 &&
    runGit(
      repositoryPath,
      ["rev-parse", "--is-shallow-repository"],
      true
    ).stdout.trim() !== "false"
  ) {
    throw new SimpleChangesError(
      "Supersession cannot be verified in a shallow clone: Git cannot prove a replacement came after the branch forked when commit parents are missing. Run `git fetch --unshallow` (and fetch the deleted head at full depth), then record the final reconciliation again.",
      EXIT_CODES.unsafe
    );
  }
  for (const supersession of supersessions) {
    const head = supersession.initialHeadRevision;
    const reportable = `Report branch ${supersession.branch} and deleted head ${head} to the user; this receipt cannot be recorded.`;
    if (
      runGit(repositoryPath, ["cat-file", "-e", `${head}^{commit}`], true)
        .exitCode !== 0
    ) {
      throw new SimpleChangesError(
        `Supersession of ${supersession.branch} is not verified: deleted head ${head} is not present locally. Fetch it first at full depth (GitLab keeps a merge request's head at refs/merge-requests/<iid>/head after its branch is deleted). ${reportable}`,
        EXIT_CODES.unsafe
      );
    }
    if (
      runGit(
        repositoryPath,
        [
          "merge-base",
          `${head}^{commit}`,
          `${receipt.targetRevision}^{commit}`,
        ],
        true
      ).exitCode !== 0
    ) {
      throw new SimpleChangesError(
        `Supersession of ${supersession.branch} is not verified: deleted head ${head} shares no history with target ${receipt.targetRevision}. ${reportable}`,
        EXIT_CODES.unsafe
      );
    }
    const containment =
      check.phase === "record"
        ? targetContainmentAudit(
            repositoryPath,
            receipt.targetRevision,
            head,
            check.targetPatchIdCache
          ).method
        : targetContainsRevision(
            repositoryPath,
            receipt.targetRevision,
            head
          ) && "target-contained";
    if (containment) {
      throw new SimpleChangesError(
        `Supersession of ${supersession.branch} is unnecessary: target ${receipt.targetRevision} already contains deleted head ${head} (${containment}), so record target-contains-head proof instead.`,
        EXIT_CODES.validation
      );
    }
    for (const replacement of supersession.replacementRevisions) {
      if (
        !targetContainsRevision(
          repositoryPath,
          receipt.targetRevision,
          replacement
        )
      ) {
        throw new SimpleChangesError(
          `Supersession of ${supersession.branch} is not verified: replacement ${replacement} is not contained in target ${receipt.targetRevision} (or is missing locally). ${reportable}`,
          EXIT_CODES.unsafe
        );
      }
      if (targetContainsRevision(repositoryPath, head, replacement)) {
        throw new SimpleChangesError(
          `Supersession of ${supersession.branch} is not verified: replacement ${replacement} is already an ancestor of deleted head ${head}, so it cannot be the work that replaced it. ${reportable}`,
          EXIT_CODES.unsafe
        );
      }
    }
  }
};

/**
 * `target-contains-head` is the one audited deletion proof Git can check
 * locally: the deleted head must be present and the target must contain it by
 * exact ancestry or by full per-commit patch equivalence (`git patch-id
 * --stable`, which ignores whitespace, as `git cherry` does), the containment
 * proof every local cleanup path shares. Both are positive checks, so a shallow
 * clone fails closed; the refusal then names the shallow clone rather than
 * suggesting lost work. It is checked where the receipt is recorded and not
 * again at loop end: loop end already binds the receipt to the current target
 * revision, so re-running the audit there would only repeat this answer for
 * receipts recorded by this client, while receipts recorded by older clients
 * never had this check and could strand a run that already deleted the branch.
 * `provider-diff-empty` is provider evidence that Git cannot reproduce locally.
 */
const assertTargetContainsDeletedHeads = (
  repositoryPath: string,
  receipt: RemoteBranchReconciliationReceipt,
  targetPatchIdCache: Map<string, Map<string, string>>
): void => {
  const nextStep =
    "If the branch is already gone and the user judges its work shipped another way, record their supersession approval instead; otherwise report the branch and head to the user.";
  for (const branch of receipt.branches) {
    if (
      branch.disposition !== "deleted-proven-obsolete" ||
      branch.obsoleteProof !== "target-contains-head"
    ) {
      continue;
    }
    const head = branch.initialHeadRevision;
    const reportable = `Report branch ${branch.name} and deleted head ${head} to the user; this receipt cannot be recorded.`;
    if (
      !head ||
      runGit(repositoryPath, ["cat-file", "-e", `${head}^{commit}`], true)
        .exitCode !== 0
    ) {
      throw new SimpleChangesError(
        `target-contains-head proof for ${branch.name} is not verified: deleted head ${head} is not present locally. Fetch it first at full depth (GitLab keeps a merge request's head at refs/merge-requests/<iid>/head after its branch is deleted); if no clone or merge request still has it, stop and report the branch to the user. ${reportable}`,
        EXIT_CODES.unsafe
      );
    }
    const audit = targetContainmentAudit(
      repositoryPath,
      receipt.targetRevision,
      head,
      targetPatchIdCache
    );
    if (audit.method !== null) {
      continue;
    }
    if (
      runGit(
        repositoryPath,
        ["rev-parse", "--is-shallow-repository"],
        true
      ).stdout.trim() !== "false"
    ) {
      throw new SimpleChangesError(
        `target-contains-head proof for ${branch.name} cannot be verified in a shallow clone: missing history hides whether target ${receipt.targetRevision} contains deleted head ${head}. Run \`git fetch --unshallow\`, then record the final reconciliation again.`,
        EXIT_CODES.unsafe
      );
    }
    throw new SimpleChangesError(
      audit.exceededMaxCommits
        ? `target-contains-head proof for ${branch.name} is not verified: deleted head ${head} is not in target ${receipt.targetRevision} and has more than ${PATCH_EQUIVALENCE_MAX_COMMITS} unique commits, too many to prove by patch equivalence. ${nextStep} ${reportable}`
        : `target-contains-head proof for ${branch.name} is not verified: target ${receipt.targetRevision} neither contains deleted head ${head} nor has a patch-equivalent commit for each of its unique commits (merge and empty commits never match). ${nextStep} ${reportable}`,
      EXIT_CODES.unsafe
    );
  }
};

/**
 * A deleted head is otherwise an unreachable object that gc may remove, which
 * would leave the run unable to end and the work unrecoverable. Pin each
 * approved head under `refs/simple-changes/superseded/<runId>/<head>`; the pin
 * is kept afterward so the user can restore the branch from it.
 */
const pinSupersededHeads = (
  repositoryPath: string,
  runId: string,
  supersessions: readonly RemoteBranchSupersession[]
): void => {
  for (const { branch, initialHeadRevision } of supersessions) {
    const pinned = runGit(
      repositoryPath,
      [
        "update-ref",
        "-m",
        `simple-changes: pin superseded ${branch}`,
        supersededHeadRef(runId, initialHeadRevision),
        initialHeadRevision,
      ],
      true
    );
    if (pinned.exitCode !== 0) {
      throw new SimpleChangesError(
        `Could not pin superseded head ${initialHeadRevision} of ${branch}: ${pinned.stderr.trim()}`,
        EXIT_CODES.unsafe
      );
    }
  }
};

const isSupersededShape = (
  branch: RemoteBranchReconciliationReceipt["branches"][number]
): boolean =>
  branch.disposition === "deleted-proven-obsolete" &&
  branch.obsoleteProof === null;

/** A deleted-merged branch the exact merged-proposal-head rule cannot prove. */
const needsAncestryShape = (
  branch: RemoteBranchReconciliationReceipt["branches"][number]
): boolean =>
  branch.disposition === "deleted-merged" &&
  // Judged from the final snapshot, as merged deletion itself is.
  (branch.proposals.some(
    (proposal) =>
      proposal.state === "open" && proposal.observedFinally !== false
  ) ||
    !branch.proposals.some(
      (proposal) =>
        proposal.state === "merged" &&
        proposal.observedFinally !== false &&
        proposal.headRevision === branch.initialHeadRevision
    ));

/**
 * Re-joins the recorded receipt with its sidecars and validates it. When it
 * fails and a sidecar its entries need is missing, the error says so.
 */
const validateRecordedRemoteBranchReconciliation = (
  lease: LoopLease,
  receipt: RemoteBranchReconciliationReceipt
): {
  ancestryProofs: RemoteBranchAncestryProof[];
  supersessions: RemoteBranchSupersession[];
} => {
  const read = (directory: Parameters<typeof readReceiptSidecar>[1]) =>
    readReceiptSidecar(lease.commonGitDirectory, directory, lease.runId);
  const storedAncestry = read(REMOTE_BRANCH_ANCESTRY_DIRECTORY);
  const storedSupersession = read(REMOTE_BRANCH_SUPERSESSION_DIRECTORY);
  const storedExternal = readReceiptSidecar(
    lease.commonGitDirectory,
    REMOTE_BRANCH_EXTERNAL_DELETIONS_DIRECTORY,
    lease.runId,
    remoteBranchReconciliationDigest(receipt)
  );
  const ancestryProofs =
    storedAncestry === null
      ? []
      : validateRemoteBranchAncestryRecord(
          storedAncestry,
          lease.runId,
          receipt
        );
  const supersessions =
    storedSupersession === null
      ? []
      : validateRemoteBranchSupersessionRecord(
          storedSupersession,
          lease.runId,
          receipt
        );
  const externalDeletions =
    storedExternal === null
      ? []
      : externalDeletionsForReceipt(storedExternal, lease.runId, receipt);
  try {
    validateRemoteBranchReconciliation(
      receipt,
      ancestryProofs,
      supersessions,
      externalDeletions
    );
  } catch (error) {
    const needs = (
      stored: unknown,
      shape: (branch: RemoteBranchReconciliationEntry) => boolean,
      kind: string
    ) => (stored === null && receipt.branches.some(shape) ? [kind] : []);
    const missing = [
      ...needs(
        storedAncestry,
        needsAncestryShape,
        "merged-head ancestry proof"
      ),
      ...needs(
        storedSupersession,
        (branch) =>
          isSupersededShape(branch) && !isExternalDeletionShape(branch),
        "supersession approval"
      ),
      ...needs(
        externalDeletions.length === 0 ? null : storedExternal,
        isExternalDeletionShape,
        "external deletion record"
      ),
    ];
    if (missing.length > 0 && error instanceof SimpleChangesError) {
      throw SimpleChangesError.withCause(
        `${error.message} No ${missing.join(" or ")} sidecar exists for ${lease.runId}; if one was recorded it is missing, so record the final reconciliation again.`,
        error.exitCode,
        error
      );
    }
    throw error;
  }
  return { ancestryProofs, supersessions };
};

const assertCurrentRemoteBranchReconciliation = (
  lease: LoopLease,
  inventory: RepositoryInventory
): void => {
  if (targetUsesGitLab(inventory) && !lease.openingRemoteInventory) {
    throw new SimpleChangesError(
      MISSING_OPENING_REMOTE_INVENTORY_BLOCKER,
      EXIT_CODES.unsafe
    );
  }
  if (
    !(
      REMOTE_RECONCILIATION_MODES.has(lease.mode) && targetUsesGitLab(inventory)
    )
  ) {
    return;
  }
  const receipt = lease.remoteBranchReconciliation;
  if (!receipt) {
    throw new SimpleChangesError(
      MISSING_REMOTE_RECONCILIATION_BLOCKER,
      EXIT_CODES.unsafe
    );
  }
  const { ancestryProofs, supersessions } =
    validateRecordedRemoteBranchReconciliation(lease, receipt);
  const targetBranch = targetBranchForRef(
    inventory.repository.primaryCheckout,
    lease.targetRef
  );
  const targetRevision = currentTargetRevision(lease);
  const project = gitLabProjectForTargetRef(
    inventory.repository.primaryCheckout,
    lease.targetRef
  );
  if (
    receipt.provider !== "gitlab" ||
    receipt.project !== project ||
    receipt.targetBranch !== targetBranch ||
    receipt.targetRevision !== targetRevision
  ) {
    throw new SimpleChangesError(
      "Cannot end the loop with a stale or mismatched remote-branch reconciliation receipt; refresh every GitLab branch and record the final accounted inventory again.",
      EXIT_CODES.unsafe
    );
  }
  assertRemoteBranchAncestry(lease.primaryCheckout, receipt, ancestryProofs);
  assertRemoteBranchSupersession(
    lease.primaryCheckout,
    receipt,
    supersessions,
    {
      phase: "loop-end",
    }
  );
};

export const recordRemoteBranchReconciliation = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string,
  receiptInput: unknown
): LoopLease & {
  remoteBranchReconciliation: RemoteBranchReconciliationReceipt;
} => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const split = splitRemoteBranchReconciliationInput(receiptInput);
  const { ancestryProofs, externalDeletions, supersessions } = split;
  const receipt: RemoteBranchReconciliationReceipt =
    validateRemoteBranchReconciliation(
      split.receipt,
      ancestryProofs,
      supersessions,
      externalDeletions
    );
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "record remote branch reconciliation",
    () => {
      const { inventory, lease } = requireOwnedLease(
        repositoryPath,
        runId,
        ownerAgentId,
        "record remote branch reconciliation"
      );
      assertControllerActive(lease);
      if (!lease.openingRemoteInventory) {
        throw new SimpleChangesError(
          "A legacy GitLab run without opening evidence cannot record an ordinary reconciliation receipt; use approved close-only post-cleanup recovery.",
          EXIT_CODES.unsafe
        );
      }
      const verification = verificationAgainst(lease, inventory);
      if (!verification.ok) {
        throw new SimpleChangesError(
          `Cannot record remote branch reconciliation with manifest violations: ${verification.violations
            .map((violation) => `${violation.code}:${violation.path}`)
            .join(", ")}`,
          EXIT_CODES.unsafe
        );
      }
      if (!(targetUsesGitLab(inventory) && receipt.provider === "gitlab")) {
        throw new SimpleChangesError(
          "Remote branch reconciliation provider must match the target GitLab remote.",
          EXIT_CODES.validation
        );
      }
      const targetBranch = targetBranchForRef(
        inventory.repository.primaryCheckout,
        lease.targetRef
      );
      const targetRevision = currentTargetRevision(lease);
      const project = gitLabProjectForTargetRef(
        inventory.repository.primaryCheckout,
        lease.targetRef
      );
      if (
        receipt.project !== project ||
        receipt.targetBranch !== targetBranch ||
        receipt.targetRevision !== targetRevision
      ) {
        throw new SimpleChangesError(
          `Remote branch reconciliation must bind GitLab project ${project ?? "(unresolved)"} and refreshed target ${targetBranch ?? "(unresolved)"} at ${targetRevision}.`,
          EXIT_CODES.validation
        );
      }
      if (
        lease.openingRemoteInventory &&
        remoteInventoryDigest(lease.openingRemoteInventory, "final") !==
          remoteInventoryDigest(receipt, "initial")
      ) {
        throw new SimpleChangesError(
          "Final remote reconciliation does not begin from the exact opening inventory persisted at loop start.",
          EXIT_CODES.validation
        );
      }
      assertRemoteBranchAncestry(
        lease.primaryCheckout,
        receipt,
        ancestryProofs
      );
      const targetPatchIdCache = new Map<string, Map<string, string>>();
      assertRemoteBranchSupersession(
        lease.primaryCheckout,
        receipt,
        supersessions,
        { phase: "record", targetPatchIdCache }
      );
      assertTargetContainsDeletedHeads(
        lease.primaryCheckout,
        receipt,
        targetPatchIdCache
      );
      pinSupersededHeads(lease.primaryCheckout, lease.runId, supersessions);
      pinExternallyDeletedHeads(
        lease.primaryCheckout,
        lease.runId,
        externalDeletions
      );
      writeRemoteBranchAncestry(lease, receipt, ancestryProofs);
      writeRemoteBranchSupersession(lease, receipt, supersessions);
      writeRemoteBranchExternalDeletions(lease, receipt, externalDeletions);
      failBeforeReconciliationLeaseWriteForTest();
      writeRemoteBranchOpenTargets(lease, receipt, split.openProposalTargets);
      const reconciledAt = new Date().toISOString();
      return writeLease({
        ...withMutationEvidence(lease, reconciledAt),
        ownerProcess: ownerProcessEvidence(reconciledAt),
        remoteBranchReconciliation: receipt,
        updatedAt: reconciledAt,
      }) as LoopLease & {
        remoteBranchReconciliation: RemoteBranchReconciliationReceipt;
      };
    }
  );
};

export { assertCurrentRemoteBranchReconciliation };
