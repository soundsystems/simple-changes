import { captureInventory } from "./inventory.ts";
import {
  controllerLifecycle,
  effectiveShipmentScopeFrozenAt,
  type LeaseLiveness,
  leaseLiveness,
  loopManifestDigest,
  readControllerBinding,
  readLeaseFromCommonDirectory,
  staleLeaseRecoveryCommand,
  withConcurrentAuthorAdmissions,
} from "./loop-lease-core.ts";
import { archiveRecordedCommand } from "./loop-lease-recovery.ts";
import { openingScopeFailure, owesFirstScope } from "./loop-lease-shipment.ts";
import {
  controllerRepo,
  emptyVerification,
  registeredController,
  staleClaimRecoveryCommands,
  unmutatedCloseReady,
  verificationAgainst,
} from "./loop-lease-verify.ts";
import type { LoopLease, LoopVerification, LoopViolation } from "./types.ts";

export interface LoopGuidance {
  headline: string;
  nextCommands: string[];
}

const violationGuidanceCommands = (
  lease: LoopLease,
  violations: readonly LoopViolation[]
): string[] => {
  const commands: string[] = [];
  const add = (command: string): void => {
    if (!commands.includes(command)) {
      commands.push(command);
    }
  };
  const codes = new Set(violations.map((violation) => violation.code));
  if (codes.has("unregistered-worktree")) {
    add(
      `simple-changes loop rebaseline --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --approved-by <user> --reason <why>`
    );
  }
  // An override cannot resolve a path whose coordination link is stale; its
  // printed claim, pause, and accept steps below do.
  const stalePaths = new Set(
    violations
      .filter((violation) => violation.code === "coordination-claim-stale")
      .map((violation) => violation.path)
  );
  for (const violation of violations) {
    if (
      violation.code === "preserved-worktree-changed" &&
      !stalePaths.has(violation.path)
    ) {
      add(
        `simple-changes loop allow --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --worktree ${violation.path} --status-digest ${violation.changeDigest ?? "<digest>"} --approved-by <user> --reason <why>`
      );
    }
  }
  if (codes.has("missing-preserved-worktree")) {
    add(
      `simple-changes loop retire-absent-worktree --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --worktree <path> --approved-by <user> --reason <why>`
    );
  }
  if (
    codes.has("missing-preserved-worktree") ||
    codes.has("missing-retained-worktree")
  ) {
    add(
      `simple-changes loop dispose-worktree --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --worktree <path> --status-digest <digest> --approved-by <user> --reason <why>`
    );
  }
  if (codes.has("incomplete-worktree-preparation")) {
    add(
      `simple-changes prepare-agent --run-id ${lease.runId} --agent-id <agent> --purpose <purpose>`
    );
  }
  // Keep every step: two checkouts each need their own accepted receipt.
  commands.push(...staleClaimRecoveryCommands(violations));
  if (
    codes.has("remote-destination-changed") ||
    codes.has("remote-destination-rebind-required")
  ) {
    add(
      "Restore the exact recorded Git remote destinations, or relinquish this controller and start a current one."
    );
  }
  if (codes.has("common-git-directory-mismatch")) {
    add(
      "Re-run this command from a checkout of the repository that owns the active loop."
    );
  }
  return commands;
};

interface LoopGuidanceContext {
  // Why this run's first shipment scope can no longer be recorded, whatever
  // plan is offered; null when it still can, or when no first scope is owed.
  firstScopeFailure: string | null;
  liveness: LeaseLiveness | null;
  unmutatedCloseAvailable: boolean;
}

// A recorded outcome disables `loop replan`; name the approved archival that
// remains for a released run, paused or not, that can no longer finish.
const withArchiveRecordedGuidance = (
  lease: LoopLease,
  guidance: LoopGuidance
): LoopGuidance =>
  lease.shipmentOutcome && effectiveShipmentScopeFrozenAt(lease)
    ? {
        headline: `${guidance.headline} It already recorded a shipment outcome, so \`loop replan\` cannot archive it; if it can no longer finish, its owner may archive it with explicit user approval through \`loop replan-status\` and \`loop archive-recorded\`, which never counts as delivery.`,
        nextCommands: [
          ...guidance.nextCommands,
          "simple-changes loop replan-status --json",
          archiveRecordedCommand(lease, "<digest>", "<digest>"),
        ],
      }
    : guidance;

const resumeCommands = (lease: LoopLease): string[] => [
  `simple-changes loop start --mode resume --agent-id <you> --repo ${controllerRepo(lease)}`,
  `simple-changes loop close-equivalent --run-id ${lease.runId} --agent-id <you> --approved-by <user> --reason <why> --repo ${controllerRepo(lease)}`,
];

const relinquishedGuidance = (lease: LoopLease): LoopGuidance =>
  withArchiveRecordedGuidance(lease, {
    headline: `Loop ${lease.runId} has released its controller. Resume it to finish its recorded work; takeover approval is unnecessary. Its existing scope and safety checks still apply.`,
    nextCommands: resumeCommands(lease),
  });

const loopGuidanceFor = (
  lease: LoopLease | null,
  verification: LoopVerification,
  {
    firstScopeFailure,
    liveness,
    unmutatedCloseAvailable,
  }: LoopGuidanceContext = {
    firstScopeFailure: null,
    liveness: null,
    unmutatedCloseAvailable: false,
  }
): LoopGuidance => {
  if (!lease) {
    return {
      headline: "No active integration loop.",
      nextCommands: ["simple-changes loop start --mode MODE --agent-id <you>"],
    };
  }
  const lifecycle = controllerLifecycle(lease);
  const awaitingUser =
    lifecycle.status === "relinquished"
      ? readControllerBinding(lease)?.awaitingUser
      : null;
  if (awaitingUser) {
    return withArchiveRecordedGuidance(lease, {
      headline: `Loop ${lease.runId} is paused waiting on the user: ${awaitingUser.questions.join(" | ")}. Once they answer, resume it; takeover approval is unnecessary, and its existing scope and safety checks still apply.`,
      nextCommands: resumeCommands(lease),
    });
  }
  if (lifecycle.status === "relinquished") {
    return relinquishedGuidance(lease);
  }
  if (liveness?.state === "stale") {
    return {
      headline: `Loop ${lease.runId} is stale: ${
        liveness.ownerSessionEnded
          ? `the harness session of its owner ${lease.ownerAgentId} has exited`
          : `its owner ${lease.ownerAgentId} cannot be proven alive`
      } and it last recorded activity at ${liveness.lastUpdatedAt}. Clearing the lease with user approval keeps every worktree and receipt.`,
      nextCommands: [
        staleLeaseRecoveryCommand(lease),
        `simple-changes loop takeover --run-id ${lease.runId} --agent-id <you> --manifest-digest ${loopManifestDigest(lease)} --approved-by <user> --reason <why>`,
      ],
    };
  }
  // Scope guidance follows record-scope's own invariants rather than the
  // whole-repository digest, so an untouched run whose scope can still be
  // recorded is told to record it, not to end.
  const endCommand = `simple-changes loop end --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --reason <why>`;
  const startCommand = `simple-changes loop start --mode ${lease.mode} --agent-id ${lease.ownerAgentId}`;
  if (unmutatedCloseAvailable && firstScopeFailure) {
    return {
      headline: `Loop ${lease.runId} has not changed anything, but its shipment scope can no longer be recorded. ${firstScopeFailure} Close this untouched run with \`loop end\`; a fresh \`loop start\` then takes a new baseline.`,
      nextCommands: [endCommand, startCommand],
    };
  }
  if (firstScopeFailure && lease.firstMutationAt !== null) {
    return {
      headline: `Loop ${lease.runId} can no longer record its first shipment scope. ${firstScopeFailure} It has already recorded mutation evidence, so \`loop end\` cannot close it: finalize it, which relinquishes its controller, then replan it with explicit approval.`,
      nextCommands: [
        `simple-changes loop finalize --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --reason <why>`,
        "simple-changes loop replan-status --json",
        `simple-changes loop replan --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --manifest-digest <digest> --status-digest <digest> --approved-by <user> --reason <why>`,
      ],
    };
  }
  if (!verification.ok) {
    const nextCommands = violationGuidanceCommands(
      lease,
      verification.violations
    );
    if (unmutatedCloseAvailable) {
      return {
        headline: `Verification for ${lease.runId} is failing with ${verification.violations.length} violation(s); resolve each violation before recording scope or guarded mutations. This run has not changed anything yet, so \`loop end\` can instead close it for a fresh \`loop start\`.`,
        nextCommands: [...nextCommands, endCommand],
      };
    }
    return {
      headline: `Verification for ${lease.runId} is failing with ${verification.violations.length} violation(s); resolve each violation before guarded mutations.`,
      nextCommands,
    };
  }
  if (lease.shipmentScopeRequired && !lease.shipmentScope) {
    return {
      headline: `Loop ${lease.runId} is healthy but has no recorded shipment scope; record it before shared integration or worktree mutations. Record-scope accepts unrelated changes made since loop start, such as claimed authors' edits and commits, other branches, and stashes. It still refuses when the target moved; policy, capabilities, or remote bindings changed; verification fails; or the controller checkout or a scoped source worktree changed since loop start.`,
      nextCommands: [
        `simple-changes loop record-scope --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --receipt <file>`,
      ],
    };
  }
  if (!lease.shipmentOutcome) {
    return {
      headline: `Loop ${lease.runId} is healthy; continue the shipment, then record its outcome before finalizing.`,
      nextCommands: [
        `simple-changes loop record-outcome --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --receipt <file>`,
        `simple-changes loop finalize --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --reason <why>`,
      ],
    };
  }
  return {
    headline: `Loop ${lease.runId} has a recorded shipment outcome; finalize to run automatic cleanup and close.`,
    nextCommands: [
      `simple-changes loop finalize --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --reason <why>`,
    ],
  };
};

export const loopStatus = (
  repositoryPath: string
): {
  guidance: LoopGuidance;
  lease: LoopLease | null;
  liveness: LeaseLiveness | null;
  verification: LoopVerification;
} => {
  const inventory = captureInventory(repositoryPath);
  const storedLease = readLeaseFromCommonDirectory(
    inventory.repository.commonGitDirectory
  );
  let lease = storedLease;
  if (storedLease && controllerLifecycle(storedLease).status === "active") {
    lease = withConcurrentAuthorAdmissions(storedLease, inventory);
  }
  const verification = lease
    ? verificationAgainst(lease, inventory)
    : emptyVerification(inventory);
  const liveness = storedLease ? leaseLiveness(storedLease) : null;
  return {
    guidance: loopGuidanceFor(lease, verification, {
      // The target binding is resolved from the current checkout's branch,
      // so the scope invariants are judged only from the controller checkout,
      // where record-scope itself must run.
      firstScopeFailure:
        lease &&
        owesFirstScope(lease) &&
        registeredController(lease)?.path ===
          inventory.repository.currentCheckout
          ? openingScopeFailure(lease, inventory)
          : null,
      liveness,
      unmutatedCloseAvailable: lease
        ? unmutatedCloseReady(lease, inventory, verification)
        : false,
    }),
    lease,
    liveness,
    verification,
  };
};
