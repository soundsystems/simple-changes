import { createHash } from "node:crypto";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { validateSchema } from "./schema.ts";
import type {
  PostCleanupRecoveryReceipt,
  RemoteBranchReconciliationEntry,
  RemoteBranchReconciliationReceipt,
  RemoteInventoryCoverage,
} from "./types.ts";

const inventoryEntries = (
  receipt: RemoteBranchReconciliationReceipt,
  phase: "initial" | "final"
) => ({
  branches: receipt.branches
    .filter((branch) =>
      phase === "initial"
        ? branch.initialHeadRevision !== null
        : branch.finalHeadRevision !== null
    )
    .map((branch) => ({
      headRevision:
        phase === "initial"
          ? branch.initialHeadRevision
          : branch.finalHeadRevision,
      name: branch.name,
      proposals: branch.proposals
        .filter((proposal) =>
          phase === "initial"
            ? proposal.observedInitially !== false
            : proposal.observedFinally !== false
        )
        .map((proposal) => ({
          headRevision: proposal.headRevision,
          objectId: proposal.objectId,
          state: proposal.state,
        })),
      protected: branch.protected,
    })),
  coverage:
    phase === "initial" ? receipt.initialCoverage : receipt.finalCoverage,
});

export const remoteInventoryDigest = (
  receipt: RemoteBranchReconciliationReceipt,
  phase: "initial" | "final" = "final"
): string =>
  createHash("sha256")
    .update(JSON.stringify(inventoryEntries(receipt, phase)))
    .digest("hex");

export const validateOpeningRemoteInventory = (
  value: unknown
): RemoteBranchReconciliationReceipt => {
  const receipt = validateRemoteBranchReconciliation(value);
  if (
    remoteInventoryDigest(receipt, "initial") !==
    remoteInventoryDigest(receipt, "final")
  ) {
    throw new SimpleChangesError(
      "Opening remote inventory must describe one unchanged complete provider snapshot.",
      EXIT_CODES.validation
    );
  }
  if (
    receipt.branches.some(
      (branch) =>
        branch.initialHeadRevision !== branch.finalHeadRevision ||
        !branch.disposition.startsWith("preserved-")
    )
  ) {
    throw new SimpleChangesError(
      "Opening remote inventory cannot claim a deletion or branch movement.",
      EXIT_CODES.validation
    );
  }
  return receipt;
};

export const validatePostCleanupRecovery = (
  value: unknown
): PostCleanupRecoveryReceipt => {
  const receipt = validateSchema<PostCleanupRecoveryReceipt>(
    "post-cleanup-recovery",
    value
  );
  const approvedBy = receipt.approvedBy.trim();
  const reason = receipt.reason.trim();
  const openingEvidenceUnavailableReason =
    receipt.openingEvidenceUnavailableReason.trim();
  if (!(approvedBy && reason && openingEvidenceUnavailableReason)) {
    throw new SimpleChangesError(
      "Post-cleanup recovery requires a nonblank approver and audit reasons.",
      EXIT_CODES.validation
    );
  }
  const first = validateOpeningRemoteInventory(receipt.firstFinalInventory);
  const second = validateOpeningRemoteInventory(receipt.secondFinalInventory);
  if (
    Date.parse(second.observedAt) <= Date.parse(first.observedAt) ||
    remoteInventoryDigest(first) !== remoteInventoryDigest(second)
  ) {
    throw new SimpleChangesError(
      "Post-cleanup recovery requires two matching complete inventories observed at distinct increasing times.",
      EXIT_CODES.validation
    );
  }
  if (
    receipt.firstClaimObservation.activeClaimCount !==
      receipt.secondClaimObservation.activeClaimCount ||
    receipt.firstClaimObservation.digest !==
      receipt.secondClaimObservation.digest ||
    Date.parse(receipt.secondClaimObservation.observedAt) <=
      Date.parse(receipt.firstClaimObservation.observedAt)
  ) {
    throw new SimpleChangesError(
      "Post-cleanup recovery requires two matching ordered worktree-claim observations.",
      EXIT_CODES.validation
    );
  }
  for (const snapshot of [first, second]) {
    if (
      snapshot.provider !== receipt.provider ||
      snapshot.project !== receipt.project ||
      snapshot.targetBranch !== receipt.targetBranch ||
      snapshot.targetRevision !== receipt.targetRevision
    ) {
      throw new SimpleChangesError(
        "Post-cleanup recovery inventories must bind the exact provider project and target.",
        EXIT_CODES.validation
      );
    }
    if (
      snapshot.branches.some((branch) =>
        branch.proposals.some((proposal) => proposal.state === "open")
      )
    ) {
      throw new SimpleChangesError(
        "Post-cleanup recovery cannot close while an open proposal remains.",
        EXIT_CODES.unsafe
      );
    }
  }
  return {
    ...receipt,
    approvedBy,
    openingEvidenceUnavailableReason,
    reason,
  };
};

const validatePagination = (
  coverage: RemoteInventoryCoverage,
  branchCount: number,
  proposalCount: number,
  label: string
): void => {
  for (const [kind, proof, expected] of [
    ["branch", coverage.branches, branchCount],
    ["proposal", coverage.proposals, proposalCount],
  ] as const) {
    const { pages } = proof;
    if (pages[0]?.cursorIn !== null || pages.at(-1)?.cursorOut !== null) {
      throw new SimpleChangesError(
        `Invalid remote branch reconciliation: ${label} ${kind} pagination must start at the first page and terminate`,
        EXIT_CODES.validation
      );
    }
    for (let index = 1; index < pages.length; index += 1) {
      if (pages[index]?.cursorIn !== pages[index - 1]?.cursorOut) {
        throw new SimpleChangesError(
          `Invalid remote branch reconciliation: ${label} ${kind} pagination cursor chain is incomplete`,
          EXIT_CODES.validation
        );
      }
    }
    if (pages.reduce((total, page) => total + page.itemCount, 0) !== expected) {
      throw new SimpleChangesError(
        `Invalid remote branch reconciliation: ${label} ${kind} pagination count does not match the accounted ledger`,
        EXIT_CODES.validation
      );
    }
  }
};

const coverageDigest = (
  receipt: RemoteBranchReconciliationReceipt,
  phase: "initial" | "final",
  kind: "branches" | "proposals",
  pageDigests: string[]
): string => {
  const entries =
    kind === "branches"
      ? receipt.branches
          .filter((branch) =>
            phase === "initial"
              ? branch.initialHeadRevision !== null
              : branch.finalHeadRevision !== null
          )
          .map((branch) => ({
            headRevision:
              phase === "initial"
                ? branch.initialHeadRevision
                : branch.finalHeadRevision,
            name: branch.name,
          }))
      : receipt.branches.flatMap((branch) =>
          branch.proposals
            .filter((proposal) =>
              phase === "initial"
                ? proposal.observedInitially !== false
                : proposal.observedFinally !== false
            )
            .map((proposal) => ({
              branch: branch.name,
              headRevision: proposal.headRevision,
              objectId: proposal.objectId,
              state: proposal.state,
            }))
        );
  return createHash("sha256")
    .update(
      JSON.stringify({
        entryDigest: createHash("sha256")
          .update(JSON.stringify(entries))
          .digest("hex"),
        pageDigests,
      })
    )
    .digest("hex");
};

const validateCoverageDigests = (
  receipt: RemoteBranchReconciliationReceipt
): void => {
  for (const phase of ["initial", "final"] as const) {
    const coverage =
      phase === "initial" ? receipt.initialCoverage : receipt.finalCoverage;
    for (const kind of ["branches", "proposals"] as const) {
      const proof = coverage[kind];
      if (
        proof.ledgerDigest !==
        coverageDigest(
          receipt,
          phase,
          kind,
          proof.pages.map((page) => page.responseDigest)
        )
      ) {
        throw new SimpleChangesError(
          `Invalid remote branch reconciliation: ${phase} ${kind} coverage digest does not bind the accounted ledger`,
          EXIT_CODES.validation
        );
      }
    }
  }
};

const fail = (branch: string, message: string): never => {
  throw new SimpleChangesError(
    `Invalid remote branch reconciliation for ${branch}: ${message}`,
    EXIT_CODES.validation
  );
};

const assertPreserved = (
  branch: RemoteBranchReconciliationEntry,
  disposition: RemoteBranchReconciliationEntry["disposition"]
): void => {
  if (branch.disposition !== disposition) {
    fail(branch.name, `expected disposition ${disposition}`);
  }
  if (!branch.finalHeadRevision) {
    fail(branch.name, "a preserved branch must remain in the final inventory");
  }
  if (branch.obsoleteProof !== null) {
    fail(branch.name, "a preserved branch cannot carry deletion proof");
  }
};

const proposalStates = (
  branch: RemoteBranchReconciliationEntry
): Set<RemoteBranchReconciliationEntry["proposals"][number]["state"]> =>
  new Set(branch.proposals.map((proposal) => proposal.state));

const assertObserved = (branch: RemoteBranchReconciliationEntry): void => {
  if (!(branch.initialHeadRevision || branch.finalHeadRevision)) {
    fail(
      branch.name,
      "the branch must appear in the initial or final inventory"
    );
  }
};

const validateDeletedMerged = (
  branch: RemoteBranchReconciliationEntry
): void => {
  if (
    branch.disposition !== "deleted-merged" ||
    branch.finalHeadRevision !== null ||
    branch.obsoleteProof !== "merged-proposal-head"
  ) {
    fail(
      branch.name,
      "merged-obsolete branches require deleted-merged, no final ref, and merged-proposal-head proof"
    );
  }
  if (!branch.initialHeadRevision) {
    fail(branch.name, "a deleted branch must exist in the initial inventory");
  }
  const exactMergedProposal = branch.proposals.some(
    (proposal) =>
      proposal.state === "merged" &&
      proposal.headRevision === branch.initialHeadRevision
  );
  if (!exactMergedProposal) {
    fail(
      branch.name,
      "merged deletion proof must bind a merged proposal to the exact initial branch head"
    );
  }
  if (branch.proposals.some((proposal) => proposal.state === "open")) {
    fail(branch.name, "an open proposal branch cannot be deleted");
  }
};

const validateAuditedBranch = (
  branch: RemoteBranchReconciliationEntry
): void => {
  const states = proposalStates(branch);
  if (branch.classification === "closed-unmerged") {
    if (
      !(states.has("closed") && !states.has("open") && !states.has("merged"))
    ) {
      fail(
        branch.name,
        "closed-unmerged requires closed proposal evidence and no open or merged proposal"
      );
    }
  } else if (branch.proposals.length > 0) {
    fail(branch.name, "no-proposal branches cannot include proposal evidence");
  }

  if (branch.disposition === "preserved-audited") {
    assertPreserved(branch, "preserved-audited");
    return;
  }
  if (
    branch.disposition !== "deleted-proven-obsolete" ||
    branch.finalHeadRevision !== null ||
    !["target-contains-head", "provider-diff-empty"].includes(
      branch.obsoleteProof ?? ""
    )
  ) {
    fail(
      branch.name,
      "audited deletion requires deleted-proven-obsolete, no final ref, and target containment or an empty provider diff"
    );
  }
};

const validateBranch = (
  branch: RemoteBranchReconciliationEntry,
  receipt: RemoteBranchReconciliationReceipt
): void => {
  assertObserved(branch);
  if (branch.name === receipt.targetBranch) {
    if (
      branch.classification !== "canonical-target" ||
      branch.finalHeadRevision !== receipt.targetRevision
    ) {
      fail(
        branch.name,
        "the canonical target must be classified and preserved at the receipt target revision"
      );
    }
    assertPreserved(branch, "preserved-target");
    return;
  }
  if (branch.protected) {
    if (branch.classification !== "protected") {
      fail(branch.name, "a protected branch must be classified as protected");
    }
    assertPreserved(branch, "preserved-protected");
    return;
  }
  if (
    !branch.initialHeadRevision ||
    (branch.finalHeadRevision &&
      branch.initialHeadRevision !== branch.finalHeadRevision)
  ) {
    if (branch.classification !== "ambiguous") {
      fail(
        branch.name,
        "a concurrent arrival or moved branch must be classified as ambiguous"
      );
    }
    assertPreserved(branch, "preserved-ambiguous");
    return;
  }
  if (branch.proposals.some((proposal) => proposal.state === "open")) {
    if (branch.classification !== "open-proposal") {
      fail(branch.name, "an open proposal branch must be classified as open");
    }
    assertPreserved(branch, "preserved-open-proposal");
    return;
  }
  if (branch.classification === "merged-obsolete") {
    validateDeletedMerged(branch);
    return;
  }
  if (
    branch.classification === "closed-unmerged" ||
    branch.classification === "no-proposal"
  ) {
    validateAuditedBranch(branch);
    return;
  }
  if (branch.classification !== "ambiguous") {
    fail(branch.name, "classification does not match its provider evidence");
  }
  assertPreserved(branch, "preserved-ambiguous");
};

export const validateRemoteBranchReconciliation = (
  value: unknown
): RemoteBranchReconciliationReceipt => {
  const receipt = validateSchema<RemoteBranchReconciliationReceipt>(
    "remote-branch-reconciliation",
    value
  );
  const names = receipt.branches.map((branch) => branch.name);
  if (new Set(names).size !== names.length) {
    throw new SimpleChangesError(
      "Invalid remote branch reconciliation: branch names must be unique",
      EXIT_CODES.validation
    );
  }
  const initialBranchCount = receipt.branches.filter(
    (branch) => branch.initialHeadRevision !== null
  ).length;
  const finalBranchCount = receipt.branches.filter(
    (branch) => branch.finalHeadRevision !== null
  ).length;
  if (
    receipt.initialBranchCount !== initialBranchCount ||
    receipt.finalBranchCount !== finalBranchCount
  ) {
    throw new SimpleChangesError(
      "Invalid remote branch reconciliation: inventory counts must match the accounted branch ledger",
      EXIT_CODES.validation
    );
  }
  const initialProposalCount = receipt.branches.reduce(
    (total, branch) =>
      total +
      branch.proposals.filter(
        (proposal) => proposal.observedInitially !== false
      ).length,
    0
  );
  const finalProposalCount = receipt.branches.reduce(
    (total, branch) =>
      total +
      branch.proposals.filter((proposal) => proposal.observedFinally !== false)
        .length,
    0
  );
  validatePagination(
    receipt.initialCoverage,
    receipt.initialBranchCount,
    initialProposalCount,
    "initial"
  );
  validateCoverageDigests(receipt);
  validatePagination(
    receipt.finalCoverage,
    receipt.finalBranchCount,
    finalProposalCount,
    "final"
  );
  for (const branch of receipt.branches) {
    validateBranch(branch, receipt);
  }
  if (
    !receipt.branches.some((branch) => branch.name === receipt.targetBranch)
  ) {
    throw new SimpleChangesError(
      "Invalid remote branch reconciliation: canonical target is missing",
      EXIT_CODES.validation
    );
  }
  return receipt;
};
