import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { validateSchema } from "./schema.ts";
import type {
  RemoteBranchReconciliationEntry,
  RemoteBranchReconciliationReceipt,
} from "./types.ts";

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
