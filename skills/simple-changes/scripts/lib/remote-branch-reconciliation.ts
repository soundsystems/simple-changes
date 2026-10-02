import { createHash } from "node:crypto";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { sha256Json } from "./hash.ts";
import { validateSchema, validateSchemaDocument } from "./schema.ts";
import type {
  PostCleanupRecoveryReceipt,
  RemoteBranchAncestryProof,
  RemoteBranchAncestryRecord,
  RemoteBranchReconciliationEntry,
  RemoteBranchReconciliationReceipt,
  RemoteBranchSupersession,
  RemoteBranchSupersessionRecord,
  RemoteInventoryCoverage,
} from "./types.ts";

const ANCESTRY_PROOF_SCHEMA = {
  $ref: "remote-branch-ancestry.schema.json#/$defs/proof",
};

const SUPERSESSION_SCHEMA = {
  $ref: "remote-branch-supersession.schema.json#/$defs/supersession",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

const validateDeletedMergedShape = (
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
};

const validateDeletedMerged = (
  branch: RemoteBranchReconciliationEntry
): void => {
  validateDeletedMergedShape(branch);
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

/**
 * A source branch with an open proposal at its initial head may be merged at
 * that head or after a fast-forward, then deleted by the provider. The ledger
 * must show the same proposal open at the initial head and merged at the proof
 * head; ancestry and target containment are verified with git where the
 * receipt is recorded and again where it is accepted.
 */
const validateAncestryMerged = (
  branch: RemoteBranchReconciliationEntry,
  proof: RemoteBranchAncestryProof
): void => {
  if (branch.classification !== "merged-obsolete") {
    fail(
      branch.name,
      "merged-head ancestry proof requires a merged-obsolete classification"
    );
  }
  validateDeletedMergedShape(branch);
  if (proof.initialHeadRevision !== branch.initialHeadRevision) {
    fail(
      branch.name,
      "merged-head ancestry proof must start at the exact initial branch head"
    );
  }
  const initiallyOpen = branch.proposals.filter(
    (proposal) =>
      proposal.objectId === proof.proposalObjectId &&
      proposal.state === "open" &&
      proposal.headRevision === proof.initialHeadRevision &&
      proposal.observedInitially !== false &&
      proposal.observedFinally === false
  );
  const finallyMerged = branch.proposals.filter(
    (proposal) =>
      proposal.objectId === proof.proposalObjectId &&
      proposal.state === "merged" &&
      proposal.headRevision === proof.mergedHeadRevision &&
      proposal.observedInitially === false &&
      proposal.observedFinally !== false
  );
  if (!(initiallyOpen.length === 1 && finallyMerged.length === 1)) {
    fail(
      branch.name,
      "merged-head ancestry proof must bind the same proposal open at the initial head and merged at the proof head"
    );
  }
  const [openEvidence] = initiallyOpen;
  if (
    branch.proposals.some(
      (proposal) => proposal.state === "open" && proposal !== openEvidence
    )
  ) {
    fail(branch.name, "an open proposal branch cannot be deleted");
  }
};

const assertAuditedClassification = (
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
  } else if (branch.classification === "no-proposal") {
    if (branch.proposals.length > 0) {
      fail(
        branch.name,
        "no-proposal branches cannot include proposal evidence"
      );
    }
  } else {
    fail(
      branch.name,
      "superseded deletion requires a closed-unmerged or no-proposal classification"
    );
  }
};

const validateAuditedBranch = (
  branch: RemoteBranchReconciliationEntry
): void => {
  assertAuditedClassification(branch);

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

/**
 * A closed-unmerged or no-proposal branch deleted while its head is outside
 * the target has no mechanical obsolescence proof. It may still be recorded
 * as deleted when a named user judged its work superseded by named target
 * commits; `obsoleteProof` stays null because the approval, not Git, is the
 * proof. Git verifies the deleted head and replacements where the receipt is
 * recorded and again where it is accepted.
 */
const validateSuperseded = (
  branch: RemoteBranchReconciliationEntry,
  supersession: RemoteBranchSupersession
): void => {
  if (branch.proposals.some((proposal) => proposal.state === "open")) {
    fail(branch.name, "an open proposal branch cannot be deleted");
  }
  assertAuditedClassification(branch);
  if (
    branch.disposition !== "deleted-proven-obsolete" ||
    branch.finalHeadRevision !== null ||
    branch.obsoleteProof !== null
  ) {
    fail(
      branch.name,
      "superseded deletion requires deleted-proven-obsolete, no final ref, and a null obsoleteProof"
    );
  }
  if (
    !branch.initialHeadRevision ||
    supersession.initialHeadRevision !== branch.initialHeadRevision
  ) {
    fail(
      branch.name,
      "supersession approval must name the exact initial branch head"
    );
  }
  if (
    new Set(supersession.replacementRevisions).size !==
      supersession.replacementRevisions.length ||
    supersession.replacementRevisions.includes(supersession.initialHeadRevision)
  ) {
    fail(
      branch.name,
      "supersession replacements must be distinct target commits other than the deleted head"
    );
  }
  if (!(supersession.approvedBy.trim() && supersession.reason.trim())) {
    fail(branch.name, "supersession requires a nonblank approver and reason");
  }
};

const validateLedgerBranch = (
  branch: RemoteBranchReconciliationEntry,
  receipt: RemoteBranchReconciliationReceipt,
  proof: RemoteBranchAncestryProof | undefined,
  supersession: RemoteBranchSupersession | undefined
): void => {
  if (!(proof || supersession)) {
    validateBranch(branch, receipt);
    return;
  }
  assertObserved(branch);
  if (proof && supersession) {
    fail(
      branch.name,
      "a branch cannot carry both merged-head ancestry proof and a supersession approval"
    );
  }
  if (branch.name === receipt.targetBranch || branch.protected) {
    fail(
      branch.name,
      `${proof ? "merged-head ancestry proof" : "supersession approval"} cannot apply to the canonical target or a protected branch`
    );
  }
  if (proof) {
    validateAncestryMerged(branch, proof);
    return;
  }
  if (supersession) {
    validateSuperseded(branch, supersession);
  }
};

const ancestryProofsByBranch = (
  receipt: RemoteBranchReconciliationReceipt,
  proofs: readonly RemoteBranchAncestryProof[]
): Map<string, RemoteBranchAncestryProof> => {
  const byBranch = new Map<string, RemoteBranchAncestryProof>();
  const names = new Set(receipt.branches.map((branch) => branch.name));
  for (const proof of proofs) {
    validateSchemaDocument<RemoteBranchAncestryProof>(
      "remote-branch-ancestry proof",
      ANCESTRY_PROOF_SCHEMA,
      proof
    );
    if (!names.has(proof.branch) || byBranch.has(proof.branch)) {
      throw new SimpleChangesError(
        `Invalid remote branch reconciliation: merged-head ancestry proof for ${proof.branch} must name exactly one ledger branch`,
        EXIT_CODES.validation
      );
    }
    byBranch.set(proof.branch, proof);
  }
  return byBranch;
};

const supersessionsByBranch = (
  receipt: RemoteBranchReconciliationReceipt,
  supersessions: readonly RemoteBranchSupersession[]
): Map<string, RemoteBranchSupersession> => {
  const byBranch = new Map<string, RemoteBranchSupersession>();
  const names = new Set(receipt.branches.map((branch) => branch.name));
  for (const supersession of supersessions) {
    validateSchemaDocument<RemoteBranchSupersession>(
      "remote-branch-supersession approval",
      SUPERSESSION_SCHEMA,
      supersession
    );
    if (!names.has(supersession.branch) || byBranch.has(supersession.branch)) {
      throw new SimpleChangesError(
        `Invalid remote branch reconciliation: supersession approval for ${supersession.branch} must name exactly one ledger branch`,
        EXIT_CODES.validation
      );
    }
    byBranch.set(supersession.branch, supersession);
  }
  return byBranch;
};

/**
 * The receipt input may carry `mergedHeadAncestry` or `supersession` on a
 * branch entry. Both are split out before the receipt is validated and
 * embedded in the lease, so the lease keeps the original receipt schema that
 * older clients read.
 */
export const splitRemoteBranchReconciliationInput = (
  value: unknown
): {
  ancestryProofs: RemoteBranchAncestryProof[];
  receipt: unknown;
  supersessions: RemoteBranchSupersession[];
} => {
  if (!(isRecord(value) && Array.isArray(value.branches))) {
    return { ancestryProofs: [], receipt: value, supersessions: [] };
  }
  const ancestryProofs: RemoteBranchAncestryProof[] = [];
  const supersessions: RemoteBranchSupersession[] = [];
  const branches = value.branches.map((branch: unknown) => {
    if (
      !(
        isRecord(branch) &&
        ("mergedHeadAncestry" in branch || "supersession" in branch)
      )
    ) {
      return branch;
    }
    const { mergedHeadAncestry, supersession, ...entry } = branch;
    if ("mergedHeadAncestry" in branch) {
      if (!isRecord(mergedHeadAncestry) || "branch" in mergedHeadAncestry) {
        throw new SimpleChangesError(
          `Invalid remote branch reconciliation: mergedHeadAncestry for ${String(entry.name)} must be an object naming proposalObjectId, initialHeadRevision, and mergedHeadRevision`,
          EXIT_CODES.validation
        );
      }
      ancestryProofs.push(
        validateSchemaDocument<RemoteBranchAncestryProof>(
          "remote-branch-ancestry proof",
          ANCESTRY_PROOF_SCHEMA,
          { ...mergedHeadAncestry, branch: entry.name }
        )
      );
    }
    if ("supersession" in branch) {
      if (!isRecord(supersession) || "branch" in supersession) {
        throw new SimpleChangesError(
          `Invalid remote branch reconciliation: supersession for ${String(entry.name)} must be an object naming initialHeadRevision, replacementRevisions, approvedBy, and reason`,
          EXIT_CODES.validation
        );
      }
      const approval = validateSchemaDocument<RemoteBranchSupersession>(
        "remote-branch-supersession approval",
        SUPERSESSION_SCHEMA,
        { ...supersession, branch: entry.name }
      );
      if (!(approval.approvedBy.trim() && approval.reason.trim())) {
        fail(
          approval.branch,
          "supersession requires a nonblank approver and reason"
        );
      }
      supersessions.push({
        ...approval,
        approvedBy: approval.approvedBy.trim(),
        reason: approval.reason.trim(),
      });
    }
    return entry;
  });
  return { ancestryProofs, receipt: { ...value, branches }, supersessions };
};

export const remoteBranchReconciliationDigest = (
  receipt: RemoteBranchReconciliationReceipt
): string => sha256Json(receipt);

/**
 * Re-joins a sidecar with the exact receipt it was recorded for. A sidecar for
 * another run or another receipt fails closed instead of being ignored.
 */
export const validateRemoteBranchAncestryRecord = (
  value: unknown,
  runId: string,
  receipt: RemoteBranchReconciliationReceipt
): RemoteBranchAncestryProof[] => {
  const record = validateSchema<RemoteBranchAncestryRecord>(
    "remote-branch-ancestry",
    value
  );
  if (
    record.runId !== runId ||
    record.receiptDigest !== remoteBranchReconciliationDigest(receipt)
  ) {
    throw new SimpleChangesError(
      "Remote-branch ancestry proofs do not match this run's recorded reconciliation receipt; record the final reconciliation again.",
      EXIT_CODES.unsafe
    );
  }
  return record.proofs;
};

/**
 * Re-joins a supersession sidecar with the exact receipt it was recorded for.
 * A sidecar for another run or another receipt fails closed instead of being
 * ignored.
 */
export const validateRemoteBranchSupersessionRecord = (
  value: unknown,
  runId: string,
  receipt: RemoteBranchReconciliationReceipt
): RemoteBranchSupersession[] => {
  const record = validateSchema<RemoteBranchSupersessionRecord>(
    "remote-branch-supersession",
    value
  );
  if (
    record.runId !== runId ||
    record.receiptDigest !== remoteBranchReconciliationDigest(receipt)
  ) {
    throw new SimpleChangesError(
      "Remote-branch supersession approvals do not match this run's recorded reconciliation receipt; record the final reconciliation again.",
      EXIT_CODES.unsafe
    );
  }
  return record.supersessions;
};

export const validateRemoteBranchReconciliation = (
  value: unknown,
  ancestryProofs: readonly RemoteBranchAncestryProof[] = [],
  supersessions: readonly RemoteBranchSupersession[] = []
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
  const proofs = ancestryProofsByBranch(receipt, ancestryProofs);
  const approvals = supersessionsByBranch(receipt, supersessions);
  for (const branch of receipt.branches) {
    validateLedgerBranch(
      branch,
      receipt,
      proofs.get(branch.name),
      approvals.get(branch.name)
    );
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
