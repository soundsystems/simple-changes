import { createHash } from "node:crypto";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import {
  coverageDigest,
  remoteInventoryDigest,
  splitRemoteBranchReconciliationInput,
  validateOpeningRemoteInventory,
  validateRemoteBranchReconciliation,
} from "./remote-branch-reconciliation.ts";
import { validateSchema } from "./schema.ts";
import type {
  RemoteBranchReconciliationEntry,
  RemoteBranchReconciliationReceipt,
  RemoteInventoryCoverage,
} from "./types.ts";

/**
 * Builds remote-branch-reconciliation receipts from normalized provider pages.
 * This module never calls a provider: a fetcher behind the provider boundary
 * (for GitLab, `scripts/adapters/gitlab-remote-inventory.ts`) writes the
 * pages, and everything here is computed from them and from Git-free data.
 */

type ProposalState = "open" | "merged" | "closed";

export interface RemoteInventoryBranchItem {
  headRevision: string;
  name: string;
  protected: boolean;
}

export interface RemoteInventoryProposalItem {
  headRevision: string | null;
  objectId: string;
  sourceBranch: string;
  state: ProposalState;
}

export interface RemoteInventoryPages {
  branchPages: Array<{
    branches: RemoteInventoryBranchItem[];
    cursorIn: string | null;
    cursorOut: string | null;
    responseDigest?: string;
  }>;
  evidence?: string[];
  observedAt: string;
  project: string;
  proposalPages: Array<{
    cursorIn: string | null;
    cursorOut: string | null;
    proposals: RemoteInventoryProposalItem[];
    responseDigest?: string;
  }>;
  provider: string;
  schemaVersion: 1;
  targetBranch: string;
}

export interface RemoteInventoryDecisions {
  deletedBranches: Array<{
    evidence: string[];
    name: string;
    obsoleteProof?: "target-contains-head" | "provider-diff-empty";
    supersession?: {
      approvedBy: string;
      initialHeadRevision: string;
      reason: string;
      replacementRevisions: string[];
    };
  }>;
  schemaVersion: 1;
}

type ProposalRecord = RemoteBranchReconciliationEntry["proposals"][number];

/** A receipt branch entry as `loop reconcile-remote-branches` accepts it. */
export type RemoteInventoryBranchEntry = RemoteBranchReconciliationEntry & {
  mergedHeadAncestry?: {
    initialHeadRevision: string;
    mergedHeadRevision: string;
    proposalObjectId: string;
  };
  supersession?: NonNullable<
    RemoteInventoryDecisions["deletedBranches"][number]["supersession"]
  >;
};

export type RemoteInventoryReceipt = Omit<
  RemoteBranchReconciliationReceipt,
  "branches"
> & { branches: RemoteInventoryBranchEntry[] };

export interface RemoteInventoryBuild {
  phase: "opening" | "final";
  receipt: RemoteInventoryReceipt;
  summary: {
    arrivedBranches: string[];
    branches: number;
    deletedBranches: string[];
    movedBranches: string[];
    proposals: number;
    targetRevision: string;
  };
}

interface Snapshot {
  branches: Map<string, RemoteInventoryBranchItem>;
  branchPages: RemoteInventoryPages["branchPages"];
  input: RemoteInventoryPages;
  proposalPages: RemoteInventoryPages["proposalPages"];
  proposalsByBranch: Map<string, ProposalRecord[]>;
  target: RemoteInventoryBranchItem;
}

const fail = (message: string): never => {
  throw new SimpleChangesError(
    `Cannot build the remote inventory: ${message}`,
    EXIT_CODES.validation
  );
};

const digestJson = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const byName = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

const assertCursorChain = (
  kind: string,
  pages: ReadonlyArray<{ cursorIn: string | null; cursorOut: string | null }>
): void => {
  if (pages[0]?.cursorIn !== null || pages.at(-1)?.cursorOut !== null) {
    fail(
      `${kind} pages must start at the first page (cursorIn null) and end at the last (cursorOut null)`
    );
  }
  for (let index = 1; index < pages.length; index += 1) {
    const cursor = pages[index]?.cursorIn;
    if (cursor === null || cursor !== pages[index - 1]?.cursorOut) {
      fail(
        `${kind} page ${index + 1} does not continue from the cursor page ${index} returned; only the first page starts and only the last page ends`
      );
    }
  }
};

const readSnapshot = (value: unknown): Snapshot => {
  const input = validateSchema<RemoteInventoryPages>(
    "remote-inventory-pages",
    value
  );
  assertCursorChain("branch", input.branchPages);
  assertCursorChain("proposal", input.proposalPages);
  const branches = new Map<string, RemoteInventoryBranchItem>();
  for (const item of input.branchPages.flatMap((page) => page.branches)) {
    if (branches.has(item.name)) {
      fail(
        `branch ${item.name} appears on two pages; the provider listing shifted during pagination, so fetch it again`
      );
    }
    branches.set(item.name, item);
  }
  const target = branches.get(input.targetBranch);
  if (!target) {
    fail(`target branch ${input.targetBranch} is not in the branch pages`);
  }
  const seenProposals = new Set<string>();
  const proposalsByBranch = new Map<string, ProposalRecord[]>();
  for (const item of input.proposalPages.flatMap((page) => page.proposals)) {
    if (seenProposals.has(item.objectId)) {
      fail(
        `proposal ${item.objectId} appears twice; the provider listing shifted during pagination, so fetch it again`
      );
    }
    seenProposals.add(item.objectId);
    const records = proposalsByBranch.get(item.sourceBranch) ?? [];
    records.push({
      headRevision: item.headRevision,
      objectId: item.objectId,
      state: item.state,
    });
    proposalsByBranch.set(item.sourceBranch, records);
  }
  return {
    branches,
    branchPages: input.branchPages,
    input,
    proposalPages: input.proposalPages,
    proposalsByBranch,
    target: target as RemoteInventoryBranchItem,
  };
};

/**
 * Coverage pages for one snapshot. A branch page accounts every branch on it;
 * a proposal page accounts only the proposals whose source branch is in the
 * ledger, which is the count the receipt validator expects.
 */
const coveragePages = (
  snapshot: Snapshot,
  ledgerBranches: ReadonlySet<string>
) => ({
  branches: snapshot.branchPages.map((page) => ({
    cursorIn: page.cursorIn,
    cursorOut: page.cursorOut,
    itemCount: page.branches.length,
    responseDigest: page.responseDigest ?? digestJson(page.branches),
  })),
  proposals: snapshot.proposalPages.map((page) => ({
    cursorIn: page.cursorIn,
    cursorOut: page.cursorOut,
    itemCount: page.proposals.filter((proposal) =>
      ledgerBranches.has(proposal.sourceBranch)
    ).length,
    responseDigest: page.responseDigest ?? digestJson(page.proposals),
  })),
});

/**
 * Fills each coverage proof's `ledgerDigest` from the receipt itself, with the
 * same function the validator uses.
 */
const withLedgerDigests = (
  receipt: RemoteBranchReconciliationReceipt,
  phase: "initial" | "final",
  pages: ReturnType<typeof coveragePages>
): RemoteInventoryCoverage => ({
  branches: {
    ledgerDigest: coverageDigest(
      receipt,
      phase,
      "branches",
      pages.branches.map((page) => page.responseDigest)
    ),
    pages: pages.branches,
  },
  proposalStates: ["closed", "merged", "open"],
  proposals: {
    ledgerDigest: coverageDigest(
      receipt,
      phase,
      "proposals",
      pages.proposals.map((page) => page.responseDigest)
    ),
    pages: pages.proposals,
  },
});

const PLACEHOLDER_COVERAGE: RemoteInventoryCoverage = {
  branches: { ledgerDigest: "", pages: [] },
  proposalStates: ["closed", "merged", "open"],
  proposals: { ledgerDigest: "", pages: [] },
};

const preservedClassification = (
  name: string,
  isProtected: boolean,
  targetBranch: string,
  moved: boolean,
  proposals: readonly ProposalRecord[]
): Pick<RemoteBranchReconciliationEntry, "classification" | "disposition"> => {
  if (name === targetBranch) {
    return {
      classification: "canonical-target",
      disposition: "preserved-target",
    };
  }
  if (isProtected) {
    return { classification: "protected", disposition: "preserved-protected" };
  }
  if (
    !moved &&
    proposals.some(
      (proposal) =>
        proposal.state === "open" && proposal.observedFinally !== false
    )
  ) {
    return {
      classification: "open-proposal",
      disposition: "preserved-open-proposal",
    };
  }
  // Every other preserved branch stays ambiguous: a builder cannot audit it.
  return { classification: "ambiguous", disposition: "preserved-ambiguous" };
};

const inputEvidence = (snapshot: Snapshot): string[] =>
  snapshot.input.evidence ?? [];

const buildOpening = (snapshot: Snapshot): RemoteInventoryBuild => {
  const names = [...snapshot.branches.keys()].sort(byName);
  const branches: RemoteInventoryBranchEntry[] = names.map((name) => {
    const branch = snapshot.branches.get(name) as RemoteInventoryBranchItem;
    const proposals = snapshot.proposalsByBranch.get(name) ?? [];
    return {
      ...preservedClassification(
        name,
        branch.protected,
        snapshot.input.targetBranch,
        false,
        proposals
      ),
      evidence: [
        `Complete paginated ${snapshot.input.provider} branch and all-state proposal inventory observed at ${snapshot.input.observedAt}; every branch is preserved at opening.`,
        ...inputEvidence(snapshot),
      ],
      finalHeadRevision: branch.headRevision,
      initialHeadRevision: branch.headRevision,
      name,
      obsoleteProof: null,
      proposals,
      protected: branch.protected,
    };
  });
  const pages = coveragePages(snapshot, new Set(names));
  const draft: RemoteBranchReconciliationReceipt = {
    branches,
    finalBranchCount: branches.length,
    finalCoverage: PLACEHOLDER_COVERAGE,
    finalInventoryComplete: true,
    initialBranchCount: branches.length,
    initialCoverage: PLACEHOLDER_COVERAGE,
    initialInventoryComplete: true,
    observedAt: snapshot.input.observedAt,
    project: snapshot.input.project,
    provider: snapshot.input.provider,
    schemaVersion: 1,
    targetBranch: snapshot.input.targetBranch,
    targetRevision: snapshot.target.headRevision,
  };
  const coverage = withLedgerDigests(draft, "initial", pages);
  const receipt = {
    ...draft,
    finalCoverage: coverage,
    initialCoverage: coverage,
  };
  validateOpeningRemoteInventory(receipt);
  return {
    phase: "opening",
    receipt,
    summary: {
      arrivedBranches: [],
      branches: branches.length,
      deletedBranches: [],
      movedBranches: [],
      proposals: branches.reduce(
        (total, branch) => total + branch.proposals.length,
        0
      ),
      targetRevision: receipt.targetRevision,
    },
  };
};

const sameProposal = (left: ProposalRecord, right: ProposalRecord): boolean =>
  left.objectId === right.objectId &&
  left.state === right.state &&
  left.headRevision === right.headRevision;

/**
 * The ledger keeps one record for a proposal seen unchanged in both
 * inventories, and two when it changed: the opening record marked
 * `observedFinally: false`, then the final one marked `observedInitially:
 * false`. Opening records keep their opening order so the receipt's initial
 * phase reproduces the opening inventory exactly.
 */
const mergedProposalRecords = (
  opening: readonly ProposalRecord[],
  final: readonly ProposalRecord[]
): ProposalRecord[] => {
  const records: ProposalRecord[] = [];
  const unchanged = new Set<string>();
  for (const proposal of opening) {
    const { headRevision, objectId, state } = proposal;
    const current = final.find((item) => item.objectId === objectId);
    if (current && sameProposal(current, proposal)) {
      unchanged.add(objectId);
      records.push({ headRevision, objectId, state });
    } else {
      records.push({ headRevision, objectId, observedFinally: false, state });
    }
  }
  for (const proposal of final) {
    if (!unchanged.has(proposal.objectId)) {
      records.push({ ...proposal, observedInitially: false });
    }
  }
  return records;
};

const decisionFor = (
  decisions: RemoteInventoryDecisions | null,
  name: string
): RemoteInventoryDecisions["deletedBranches"][number] | undefined =>
  decisions?.deletedBranches.find((decision) => decision.name === name);

/**
 * Mechanical deletion proof from provider records alone: a final merged
 * record at the exact opening head, or the one proposal open at the opening
 * head that later merged at another head. `loop reconcile-remote-branches`
 * still checks the second case's ancestry and target containment with Git.
 */
const mergedProof = (
  initialHead: string,
  proposals: readonly ProposalRecord[]
): Pick<
  RemoteInventoryBranchEntry,
  | "classification"
  | "disposition"
  | "evidence"
  | "mergedHeadAncestry"
  | "obsoleteProof"
> | null => {
  const atHead = proposals.find(
    (proposal) =>
      proposal.observedFinally !== false &&
      proposal.state === "merged" &&
      proposal.headRevision === initialHead
  );
  if (atHead) {
    return {
      classification: "merged-obsolete",
      disposition: "deleted-merged",
      evidence: [
        `Proposal ${atHead.objectId} merged at the exact opening head ${initialHead}, and the branch is absent from the final inventory.`,
      ],
      obsoleteProof: "merged-proposal-head",
    };
  }
  const openedAtHead = proposals.filter(
    (proposal) =>
      proposal.state === "open" &&
      proposal.headRevision === initialHead &&
      proposal.observedFinally === false
  );
  const mergedLater = proposals.filter(
    (proposal) =>
      proposal.state === "merged" &&
      proposal.observedInitially === false &&
      openedAtHead.some((open) => open.objectId === proposal.objectId)
  );
  const [merged] = mergedLater;
  if (
    !(
      openedAtHead.length === 1 &&
      mergedLater.length === 1 &&
      merged?.headRevision
    )
  ) {
    return null;
  }
  return {
    classification: "merged-obsolete",
    disposition: "deleted-merged",
    evidence: [
      `Proposal ${merged.objectId} was open at the opening head ${initialHead} and merged at ${merged.headRevision}; loop reconcile-remote-branches verifies with Git that the opening head is that merged head's ancestor and that the target contains it.`,
    ],
    mergedHeadAncestry: {
      initialHeadRevision: initialHead,
      mergedHeadRevision: merged.headRevision,
      proposalObjectId: merged.objectId,
    },
    obsoleteProof: "merged-proposal-head",
  };
};

const deletedEntry = (
  opening: RemoteBranchReconciliationEntry,
  proposals: ProposalRecord[],
  decisions: RemoteInventoryDecisions | null
): RemoteInventoryBranchEntry => {
  const initialHead = opening.initialHeadRevision as string;
  const base = {
    finalHeadRevision: null,
    initialHeadRevision: initialHead,
    name: opening.name,
    proposals,
    protected: opening.protected,
  };
  const finalRecords = proposals.filter(
    (proposal) => proposal.observedFinally !== false
  );
  if (finalRecords.some((proposal) => proposal.state === "open")) {
    fail(
      `branch ${opening.name} was deleted while a proposal on it is still open; no receipt can record that deletion, so report the branch, its opening head ${initialHead}, and the open proposal to the user`
    );
  }
  const decision = decisionFor(decisions, opening.name);
  const merged = mergedProof(initialHead, proposals);
  if (merged && decision) {
    fail(
      `branch ${opening.name} is already proven obsolete by its merged proposal; remove its decision`
    );
  }
  if (merged) {
    return { ...base, ...merged };
  }
  if (!decision) {
    return fail(
      `branch ${opening.name} (opening head ${initialHead}) was deleted without a merged proposal that proves it obsolete; add a --decisions entry naming target-contains-head, provider-diff-empty, or a user-approved supersession, or report it to the user`
    );
  }
  // The validator judges an audited deletion by the final proposal records.
  const states = new Set(finalRecords.map((proposal) => proposal.state));
  let classification: "closed-unmerged" | "no-proposal";
  if (states.size === 0) {
    classification = "no-proposal";
  } else if (states.has("closed") && !states.has("merged")) {
    classification = "closed-unmerged";
  } else {
    return fail(
      `branch ${opening.name} has a merged proposal record that does not prove its deletion, so no decision can record it; report it to the user`
    );
  }
  if (Boolean(decision.obsoleteProof) === Boolean(decision.supersession)) {
    fail(
      `the decision for ${opening.name} must name exactly one of obsoleteProof or supersession`
    );
  }
  return {
    ...base,
    classification,
    disposition: "deleted-proven-obsolete",
    evidence: decision.evidence,
    obsoleteProof: decision.obsoleteProof ?? null,
    ...(decision.supersession ? { supersession: decision.supersession } : {}),
  };
};

const presentEntry = (
  opening: RemoteBranchReconciliationEntry | undefined,
  current: RemoteInventoryBranchItem,
  proposals: ProposalRecord[],
  targetBranch: string
): RemoteInventoryBranchEntry => {
  const initialHead = opening?.initialHeadRevision ?? null;
  const moved = initialHead !== null && initialHead !== current.headRevision;
  let evidence: string;
  if (!opening) {
    evidence = `Arrived after the opening inventory at ${current.headRevision}; preserved.`;
  } else if (moved) {
    evidence = `Moved from ${initialHead} to ${current.headRevision} after the opening inventory; preserved.`;
  } else {
    evidence = `Present at ${current.headRevision} in the opening and final inventories; preserved.`;
  }
  return {
    ...preservedClassification(
      current.name,
      current.protected,
      targetBranch,
      opening === undefined || moved,
      proposals
    ),
    evidence: [evidence],
    finalHeadRevision: current.headRevision,
    initialHeadRevision: initialHead,
    name: current.name,
    obsoleteProof: null,
    proposals,
    protected: current.protected,
  };
};

const assertDecisionsUsed = (
  decisions: RemoteInventoryDecisions | null,
  deleted: ReadonlySet<string>
): void => {
  const names = (decisions?.deletedBranches ?? []).map(
    (decision) => decision.name
  );
  if (new Set(names).size !== names.length) {
    fail("each deleted branch may have only one decision");
  }
  const unused = names.filter((name) => !deleted.has(name));
  if (unused.length > 0) {
    fail(
      `decisions name branches that were not deleted during the run: ${unused.join(", ")}`
    );
  }
};

const buildFinal = (
  snapshot: Snapshot,
  openingValue: unknown,
  decisions: RemoteInventoryDecisions | null
): RemoteInventoryBuild => {
  const opening = validateOpeningRemoteInventory(openingValue);
  const { input } = snapshot;
  if (
    opening.provider !== input.provider ||
    opening.project !== input.project ||
    opening.targetBranch !== input.targetBranch
  ) {
    fail(
      `the final pages describe ${input.provider} ${input.project} ${input.targetBranch}, but the opening inventory describes ${opening.provider} ${opening.project} ${opening.targetBranch}`
    );
  }
  const openingNames = new Set(opening.branches.map((branch) => branch.name));
  const deleted = new Set<string>();
  const moved: string[] = [];
  const branches: RemoteInventoryBranchEntry[] = opening.branches.map(
    (openingBranch) => {
      const current = snapshot.branches.get(openingBranch.name);
      const proposals = mergedProposalRecords(
        openingBranch.proposals,
        snapshot.proposalsByBranch.get(openingBranch.name) ?? []
      );
      if (!current) {
        if (
          openingBranch.name === input.targetBranch ||
          openingBranch.protected
        ) {
          fail(
            `${openingBranch.protected ? "protected branch" : "the canonical target"} ${openingBranch.name} is missing from the final inventory`
          );
        }
        deleted.add(openingBranch.name);
        return deletedEntry(openingBranch, proposals, decisions);
      }
      if (current.protected !== openingBranch.protected) {
        fail(
          `branch ${current.name} changed protection during the run; a receipt cannot record both states, so report it and take a fresh opening inventory on the next run`
        );
      }
      if (
        current.headRevision !== openingBranch.initialHeadRevision &&
        current.name !== input.targetBranch
      ) {
        moved.push(current.name);
      }
      return presentEntry(
        openingBranch,
        current,
        proposals,
        input.targetBranch
      );
    }
  );
  assertDecisionsUsed(decisions, deleted);
  const arrived = [...snapshot.branches.keys()]
    .filter((name) => !openingNames.has(name))
    .sort(byName);
  for (const name of arrived) {
    branches.push(
      presentEntry(
        undefined,
        snapshot.branches.get(name) as RemoteInventoryBranchItem,
        (snapshot.proposalsByBranch.get(name) ?? []).map((proposal) => ({
          ...proposal,
          observedInitially: false,
        })),
        input.targetBranch
      )
    );
  }
  for (const branch of branches) {
    branch.evidence.push(...inputEvidence(snapshot));
  }
  const ledgerNames = new Set(branches.map((branch) => branch.name));
  const draft: RemoteBranchReconciliationReceipt = {
    branches,
    finalBranchCount: snapshot.branches.size,
    finalCoverage: PLACEHOLDER_COVERAGE,
    finalInventoryComplete: true,
    initialBranchCount: opening.initialBranchCount,
    initialCoverage: opening.initialCoverage,
    initialInventoryComplete: true,
    observedAt: input.observedAt,
    project: input.project,
    provider: input.provider,
    schemaVersion: 1,
    targetBranch: input.targetBranch,
    targetRevision: snapshot.target.headRevision,
  };
  const receipt: RemoteInventoryReceipt = {
    ...draft,
    branches,
    finalCoverage: withLedgerDigests(
      draft,
      "final",
      coveragePages(snapshot, ledgerNames)
    ),
  };
  const split = splitRemoteBranchReconciliationInput(receipt);
  const validated = validateRemoteBranchReconciliation(
    split.receipt,
    split.ancestryProofs,
    split.supersessions
  );
  if (
    remoteInventoryDigest(opening, "final") !==
    remoteInventoryDigest(validated, "initial")
  ) {
    fail("the final receipt does not begin from the exact opening inventory");
  }
  return {
    phase: "final",
    receipt,
    summary: {
      arrivedBranches: arrived,
      branches: snapshot.branches.size,
      deletedBranches: [...deleted],
      movedBranches: moved,
      proposals: branches.reduce(
        (total, branch) =>
          total +
          branch.proposals.filter(
            (proposal) => proposal.observedFinally !== false
          ).length,
        0
      ),
      targetRevision: receipt.targetRevision,
    },
  };
};

/**
 * Builds the opening receipt from one snapshot, or, given the exact opening
 * receipt the run started with, the final reconciliation receipt over the
 * union of both inventories. Either result is validated with the runtime's
 * own receipt validator before it is returned.
 */
export const buildRemoteInventory = (
  pages: unknown,
  options: { decisions?: unknown; opening?: unknown } = {}
): RemoteInventoryBuild => {
  const snapshot = readSnapshot(pages);
  if (options.opening === undefined) {
    if (options.decisions !== undefined) {
      fail("deletion decisions apply only to a final inventory");
    }
    return buildOpening(snapshot);
  }
  const decisions =
    options.decisions === undefined
      ? null
      : validateSchema<RemoteInventoryDecisions>(
          "remote-inventory-decisions",
          options.decisions
        );
  return buildFinal(snapshot, options.opening, decisions);
};
