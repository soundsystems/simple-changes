import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import type {
  CoordinationAdapterCapabilities,
  CoordinationBlocker,
  CoordinationRequest,
  WorktreeClaim,
} from "./types.ts";

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
  automatic: boolean;
  blocker: CoordinationBlocker | null;
  capabilities: CoordinationAdapterCapabilities;
}

export const probeCoordinationAdapter = (
  adapterInput: string,
  ownerRef: string | null,
  platform: NodeJS.Platform = process.platform
): CoordinationCapabilityProbe => {
  const adapter = adapterInput.trim();
  if (!ADAPTER_PATTERN.test(adapter)) {
    throw new SimpleChangesError(
      "adapter must be a bounded lowercase slug.",
      EXIT_CODES.usage
    );
  }
  const capabilities = PROFILES[adapter] ?? manualProfile(adapter);
  if (POSIX_ONLY_ADAPTERS.has(adapter) && platform === "win32") {
    return {
      automatic: false,
      blocker: {
        adapter,
        capability: "scope",
        code: "unsupported-capability",
        manualNextAction:
          "This adapter does not support automated coordination on native Windows. Contact the exact owner in the harness UI, ask it to pause at a safe boundary, and validate the returned receipt before continuing.",
        scope: capabilities.scope,
      },
      capabilities,
    };
  }
  if (
    capabilities.discovery === "exact-ref" &&
    (!ownerRef || ownerRef.trim().length === 0)
  ) {
    return {
      automatic: false,
      blocker: {
        adapter,
        capability: "owner-ref",
        code: "manual-coordination-required",
        manualNextAction:
          "Ask the exact worktree owner to run the emitted pause command and return its receipt ID.",
        scope: capabilities.scope,
      },
      capabilities,
    };
  }
  const automatic =
    capabilities.discovery !== "none" &&
    capabilities.delivery !== "none" &&
    capabilities.delivery !== "interactive-manual" &&
    capabilities.wait !== "none";
  let blocker: CoordinationBlocker | null = null;
  if (!automatic) {
    let capability: CoordinationBlocker["capability"] = "wait";
    if (capabilities.discovery === "none") {
      capability = "discovery";
    } else if (
      capabilities.delivery === "none" ||
      capabilities.delivery === "interactive-manual"
    ) {
      capability = "delivery";
    }
    blocker = {
      adapter,
      capability,
      code: "unsupported-capability",
      manualNextAction:
        "Contact the exact owner in the harness UI, ask it to pause at a safe boundary, and validate the returned receipt before continuing.",
      scope: capabilities.scope,
    };
  }
  return {
    automatic,
    blocker,
    capabilities,
  };
};

const boundedMessage = (value: string): string => {
  const normalized = value.replaceAll(/[\r\n\t]+/gu, " ").trim();
  return normalized.slice(0, 500);
};

export const buildCoordinationRequest = (
  action: CoordinationRequest["action"],
  claim: WorktreeClaim,
  runId: string
): CoordinationRequest => {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new SimpleChangesError(
      "run ID must match run-[a-z0-9-]+.",
      EXIT_CODES.usage
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
  };
};
