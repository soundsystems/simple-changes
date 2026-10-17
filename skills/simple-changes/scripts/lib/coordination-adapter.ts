import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { currentHarnessSession } from "./harness-session.ts";
import type {
  CoordinationAdapterCapabilities,
  CoordinationBlocker,
  CoordinationRequest,
  LoopLease,
  WorktreeClaim,
} from "./types.ts";

type Environment = Record<string, string | undefined>;

const ADAPTER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const RUN_ID_PATTERN = /^run-[a-z0-9-]+$/u;

const PROFILES: Record<string, CoordinationAdapterCapabilities> = {
  "claude-code": {
    adapter: "claude-code",
    conditions: [
      "Claude Code 2.1.224 or later with cross-session messaging enabled",
      "The owner session runs on this same macOS or Linux host",
      "Held, refused, or unavailable delivery is surfaced as a blocker, never retried as automation",
    ],
    delivery: "live-bidirectional",
    discovery: "enumerate-local",
    scope: "same-host",
    wait: "event",
    worktreeIdentity: "claim-only",
  },
  "codex-desktop": {
    adapter: "codex-desktop",
    conditions: [
      "Codex desktop task tools are available to the orchestration layer",
    ],
    delivery: "live-bidirectional",
    discovery: "enumerate-local",
    scope: "same-host",
    wait: "event",
    worktreeIdentity: "native",
  },
  "cursor-cloud": {
    adapter: "cursor-cloud",
    conditions: [
      "The owner reference is the controller-managed Cursor agent or run identity",
      "The Cursor API credential stays in the host layer and never enters coordination metadata",
    ],
    delivery: "follow-up",
    discovery: "exact-ref",
    scope: "account-remote",
    wait: "poll",
    worktreeIdentity: "claim-only",
  },
  "grok-build": {
    adapter: "grok-build",
    conditions: [
      "The session endpoint is owned by the coordinating process",
      "A live session is never concurrently resumed by ID",
    ],
    delivery: "follow-up",
    discovery: "exact-ref",
    scope: "same-process",
    wait: "poll",
    worktreeIdentity: "claim-only",
  },
  "hermes-gateway": {
    adapter: "hermes-gateway",
    conditions: [
      "The exact owner session is reachable through this process's TUI gateway",
      "A Kanban comment alone is not treated as a live safe-boundary pause",
    ],
    delivery: "live-bidirectional",
    discovery: "enumerate-local",
    scope: "same-process",
    wait: "poll",
    worktreeIdentity: "claim-only",
  },
};

const POSIX_ONLY_ADAPTERS = new Set(["claude-code"]);

const manualProfile = (adapter: string): CoordinationAdapterCapabilities => ({
  adapter,
  conditions: [],
  delivery: "interactive-manual",
  discovery: "none",
  scope: "manual",
  wait: "none",
  worktreeIdentity: "claim-only",
});

export interface CoordinationCapabilityProbe {
  /** Whether the owner's adapter profile allows automation once the executing host verifies its own transport and every condition. */
  adapterSupportsAutomation: boolean;
  /**
   * Always false. The runtime cannot see or verify the executing host's
   * discovery, delivery, or wait tools, so nothing it constructs is
   * delivered or automatically deliverable.
   */
  automatic: false;
  blocker: CoordinationBlocker;
  /** The target owner's nominal adapter profile, never the executing host's. */
  capabilities: CoordinationAdapterCapabilities;
  /** The executing host as its session variables report it; its transport stays unverified. */
  host: { harness: string | null; transport: "unverified" };
}

const HOST_TRANSPORT_NEXT_ACTION =
  "Nothing was sent, and this runtime cannot see or verify any delivery tool in the executing host. Deliver the safe message to this exact owner only through a delivery tool this host actually has for it, after verifying every listed condition, or relay it yourself or through the user. Then wait for the owner's own answer, its exact pause receipt for a pause or detach request. Report a missing, refused, or held delivery as a blocker; never retry it automatically, and never pick a session by its title.";

/**
 * Probe the target owner's adapter profile. The profile says what the
 * owner's surface could support; it says nothing about the host running this
 * command, whose tools the runtime cannot see. So the probe is never
 * automatic: a profile that could be automated returns a
 * `host-transport-unverified` blocker naming the manual path, and every other
 * profile returns its structured manual blocker.
 */
export const probeCoordinationAdapter = (
  adapterInput: string,
  ownerRef: string | null,
  platform: NodeJS.Platform = process.platform,
  environment: Environment = process.env
): CoordinationCapabilityProbe => {
  const adapter = adapterInput.trim();
  if (!ADAPTER_PATTERN.test(adapter)) {
    throw new SimpleChangesError(
      "adapter must be a bounded lowercase slug.",
      EXIT_CODES.usage
    );
  }
  const capabilities = PROFILES[adapter] ?? manualProfile(adapter);
  const host = {
    harness: currentHarnessSession(environment)?.harness ?? null,
    transport: "unverified" as const,
  };
  const manual = (
    blocker: CoordinationBlocker
  ): CoordinationCapabilityProbe => ({
    adapterSupportsAutomation: false,
    automatic: false,
    blocker,
    capabilities,
    host,
  });
  if (POSIX_ONLY_ADAPTERS.has(adapter) && platform === "win32") {
    return manual({
      adapter,
      capability: "scope",
      code: "unsupported-capability",
      manualNextAction:
        "This adapter does not support automated coordination on native Windows. Contact the exact owner in the harness UI, ask it to pause at a safe boundary, and validate the returned receipt before continuing.",
      scope: capabilities.scope,
    });
  }
  if (
    capabilities.discovery === "exact-ref" &&
    (!ownerRef || ownerRef.trim().length === 0)
  ) {
    return manual({
      adapter,
      capability: "owner-ref",
      code: "manual-coordination-required",
      manualNextAction:
        "Ask the exact worktree owner to run the emitted pause command and return its receipt ID.",
      scope: capabilities.scope,
    });
  }
  const profileAutomatable =
    capabilities.discovery !== "none" &&
    capabilities.delivery !== "none" &&
    capabilities.delivery !== "interactive-manual" &&
    capabilities.wait !== "none";
  if (profileAutomatable) {
    return {
      adapterSupportsAutomation: true,
      automatic: false,
      blocker: {
        adapter,
        capability: "transport",
        code: "host-transport-unverified",
        manualNextAction: HOST_TRANSPORT_NEXT_ACTION,
        scope: capabilities.scope,
      },
      capabilities,
      host,
    };
  }
  let capability: CoordinationBlocker["capability"] = "wait";
  if (capabilities.discovery === "none") {
    capability = "discovery";
  } else if (
    capabilities.delivery === "none" ||
    capabilities.delivery === "interactive-manual"
  ) {
    capability = "delivery";
  }
  return manual({
    adapter,
    capability,
    code: "unsupported-capability",
    manualNextAction:
      "Contact the exact owner in the harness UI, ask it to pause at a safe boundary, and validate the returned receipt before continuing.",
    scope: capabilities.scope,
  });
};

const boundedMessage = (value: string): string => {
  const normalized = value.replaceAll(/[\r\n\t]+/gu, " ").trim();
  return normalized.slice(0, 500);
};

/**
 * Build the bounded request for one exact owner. The run must be the active
 * loop, whose controller is the one that will accept the owner's receipt.
 * The request is only constructed: nothing is sent or recorded.
 */
export const buildCoordinationRequest = (
  action: CoordinationRequest["action"],
  claim: WorktreeClaim,
  runId: string,
  lease: LoopLease | null
): CoordinationRequest => {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new SimpleChangesError(
      "run ID must match run-[a-z0-9-]+.",
      EXIT_CODES.usage
    );
  }
  if (
    !lease ||
    lease.runId !== runId ||
    (lease.controller?.status ?? "active") !== "active"
  ) {
    throw new SimpleChangesError(
      lease
        ? `Run ${runId} is not the active loop (the recorded lease is ${lease.runId}, controller ${lease.controller?.status ?? "active"}); a coordination request must name the active run that will accept the owner's receipt.`
        : `No loop lease is recorded, so run ${runId} is not active; a coordination request must name the active run that will accept the owner's receipt.`,
      EXIT_CODES.unsafe
    );
  }
  if (
    (action === "request-pause" || action === "request-detach") &&
    (claim.state === "released" || claim.state === "stale")
  ) {
    throw new SimpleChangesError(
      `Cannot request coordination for a ${claim.state} claim; the owner must refresh the claim first.`,
      EXIT_CODES.unsafe
    );
  }
  let actionText =
    "Pause at a safe boundary and return the exact Simple Changes pause receipt ID.";
  if (action === "notify-resume") {
    if (
      claim.state !== "resume-ready" ||
      !claim.resumeTarget ||
      claim.resumeTarget.runId !== runId
    ) {
      throw new SimpleChangesError(
        "Resume notification requires a resume-ready claim for this exact run.",
        EXIT_CODES.unsafe
      );
    }
    actionText = `The controller verified ${claim.resumeTarget.targetRef} at exact SHA ${claim.resumeTarget.targetSha}. Your worktree remains owner-controlled and preserved; refresh your claim before resuming.`;
  } else if (action === "request-detach") {
    actionText =
      "Pause at a safe boundary and acknowledge detach-clean-checkout only if this worktree is clean.";
  }
  return {
    action,
    claimId: claim.claimId,
    owner: claim.owner,
    repository: {
      commonGitDirectory: claim.commonGitDirectory,
      worktreePath: claim.path,
    },
    runId,
    safeMessage: boundedMessage(
      `${actionText} Claim ${claim.claimId}; run ${runId}; worktree ${claim.path}.`
    ),
    state: "constructed",
  };
};
