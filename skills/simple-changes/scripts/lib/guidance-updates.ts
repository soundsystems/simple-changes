import type { ChangelogCoordination, RepoPolicy } from "./types.ts";

export const CURRENT_GUIDANCE_VERSION = 11;

export type GuidanceUpdateAction =
  | "review-settings"
  | "keep-current-settings"
  | "defer"
  | "view-release-notes"
  | "review-with-simple-changelogs";

export interface GuidanceUpdateNotice {
  actionDescriptions: Record<GuidanceUpdateAction, string>;
  actions: GuidanceUpdateAction[];
  changelogHandoff: {
    available: boolean;
    owner: "simple-changelogs" | null;
    reason: string;
  };
  changes: Array<{
    kind: "behavior" | "onboarding" | "integration";
    summary: string;
    version: number;
  }>;
  currentVersion: number;
  headline: "**Simple Changes has recently been updated.**";
  recommendedAction: "review-settings";
  releaseNotes: {
    available: true;
    command: "simple-changes release-notes";
    label: "View detailed Simple Changes release notes";
  };
  status: "current" | "update-available";
  storedDisposition: RepoPolicy["guidance"]["disposition"] | null;
  storedVersion: number | null;
  summaryBullets: string[];
  walkthroughQuestion: "Would you like me to walk you through all recent updates to the skill?";
}

interface GuidanceUpdateDefinition {
  changelogReviewRelevant: boolean;
  changes: GuidanceUpdateNotice["changes"];
  version: number;
}

const GUIDANCE_UPDATES: GuidanceUpdateDefinition[] = [
  {
    changelogReviewRelevant: true,
    changes: [
      {
        kind: "behavior",
        summary:
          "Meaningful Simple Changes behavior updates now appear once before the next write-capable run instead of being applied silently.",
        version: 2,
      },
      {
        kind: "onboarding",
        summary:
          "Update review covers only Simple Changes workflow settings and remembers whether the user reviewed, kept, or deferred them for this guidance version.",
        version: 2,
      },
      {
        kind: "integration",
        summary:
          "When Simple Changelogs is present, any review of its settings or existing release notes is offered as a separate handoff owned by that skill.",
        version: 2,
      },
    ],
    version: 2,
  },
  {
    changelogReviewRelevant: true,
    changes: [
      {
        kind: "behavior",
        summary:
          "Urgent Ship requests now use a run-only expedited path, while deployment before independent review requires explicit break-glass direction and rollback evidence.",
        version: 3,
      },
      {
        kind: "integration",
        summary:
          "Emergency deployments remain durably incomplete until review, forward changelog/version reconciliation, canonical production verification, and cleanup finish.",
        version: 3,
      },
    ],
    version: 3,
  },
  {
    changelogReviewRelevant: true,
    changes: [
      {
        kind: "behavior",
        summary:
          "Every integration controller now finalizes its lease: completed runs close, while incomplete runs relinquish control without losing reconciliation evidence.",
        version: 4,
      },
      {
        kind: "onboarding",
        summary:
          "Ship preferences now offer standard or expedited-by-default behavior after a short workflow primer; break-glass defaults remain an advanced manual policy setting.",
        version: 4,
      },
      {
        kind: "integration",
        summary:
          "Relinquished runs can be resumed by a new controller, and abandoned active controllers require an exact manifest-bound, user-authorized takeover.",
        version: 4,
      },
    ],
    version: 4,
  },
  {
    changelogReviewRelevant: true,
    changes: [
      {
        kind: "behavior",
        summary:
          "Installed updates now open with a clear Simple Changes headline and short practical bullets instead of internal guidance-checkpoint language.",
        version: 5,
      },
      {
        kind: "onboarding",
        summary:
          "First use now includes a plain-language walkthrough of every main workflow, from safe sync and preview through review, merge, ship, resume, and cleanup.",
        version: 5,
      },
      {
        kind: "integration",
        summary:
          "Simple Changelogs updates are detected separately, and a required changelog update is resolved before any shipment loop begins.",
        version: 5,
      },
    ],
    version: 5,
  },
  {
    changelogReviewRelevant: true,
    changes: [
      {
        kind: "behavior",
        summary:
          "A saved break-glass default paired with automatic production authority now makes an ordinary Ship request sufficient; rollback and completion evidence remain mandatory.",
        version: 6,
      },
      {
        kind: "onboarding",
        summary:
          "Advanced onboarding now offers break-glass shipping and two target-bound automatic migration tiers; new migrationHandling defaults to ask-after-review and migrationTargets defaults to an empty list.",
        version: 6,
      },
      {
        kind: "integration",
        summary:
          "Every migration is reviewed before apply, and automatic tiers refuse destructive, irreversible, unbounded, lock-heavy, unprotected, or target-mismatched work.",
        version: 6,
      },
    ],
    version: 6,
  },
  {
    changelogReviewRelevant: true,
    changes: [
      {
        kind: "onboarding",
        summary:
          "Ship setup now offers configure-harness, ask, or never for Git pushes; the new gitPushAuthorization setting defaults to ask.",
        version: 7,
      },
      {
        kind: "integration",
        summary:
          "Harness configuration is limited to the narrowest verified repository- and remote-scoped push rule and cannot override host security, credentials, branch protections, or provider policy.",
        version: 7,
      },
      {
        kind: "behavior",
        summary:
          "A clean target-contained worktree can now stay in place as an exact unchanged shipment exclusion; any later change requires an owner claim or stable pause before integration continues.",
        version: 7,
      },
    ],
    version: 7,
  },
  {
    changelogReviewRelevant: false,
    changes: [
      {
        kind: "onboarding",
        summary:
          "Update prompts now explain the new abilities before asking for a disposition and recommend reviewing what changed instead of skipping the walkthrough.",
        version: 8,
      },
      {
        kind: "behavior",
        summary:
          "Choosing automatic Git pushes now requires a plain-language confirmation of the exact repository-and-remote scope and every authority it does not grant before the setting is saved.",
        version: 8,
      },
    ],
    version: 8,
  },
  {
    changelogReviewRelevant: true,
    changes: [
      {
        kind: "behavior",
        summary:
          "Integrate, Ship, Reconcile, and Resume now automatically remove unchanged clean target-contained worktrees, stale worktree metadata, and merged local branches; normalize tracked dirty-primary paths already exact in the target when the index has no unique state; then restore or fast-forward the primary checkout.",
        version: 9,
      },
      {
        kind: "integration",
        summary:
          "Incomplete finalization now exits nonzero; a dirty or stale primary remains a resumable blocker and can no longer be reported as a completed shipment merely because its files were preserved.",
        version: 9,
      },
      {
        kind: "behavior",
        summary:
          "Active claims, retained exclusions, late arrivals, untracked or divergent primary paths, unique staged state, dirty non-primary worktrees, and unique commits remain protected; multiple exact historical overrides can be approved sequentially without an all-at-once deadlock.",
        version: 9,
      },
    ],
    version: 9,
  },
  {
    changelogReviewRelevant: true,
    changes: [
      {
        kind: "behavior",
        summary:
          "User-facing messages now lead with what happened, what it means, and what happens next, and most routine updates stay within one to three short sentences.",
        version: 10,
      },
      {
        kind: "integration",
        summary:
          "Exact revisions, paths, commands, providers, and workflow states remain available after the plain-language explanation whenever safety, authority, verification, or a user decision depends on them, and full technical detail remains available on request.",
        version: 10,
      },
    ],
    version: 10,
  },
  {
    changelogReviewRelevant: true,
    changes: [
      {
        kind: "integration",
        summary:
          "Every GitLab Queue, Sweep, Integrate, Ship, Reconcile, and Resume run now saves the complete opening branch and proposal inventory before any provider mutation; a legacy record without that evidence cannot prepare author worktrees, and ordinary reconciliation, ending, or finalization cannot bypass its close-only recovery path.",
        version: 11,
      },
      {
        kind: "behavior",
        summary:
          "With explicit approval and nonblank audit reasons, legacy cleanup that already finished can close its old bookkeeping only after two matching complete post-cleanup inventories and two ordered zero-active worktree-claim observations with matching digests prove that no proposal or cleanup blocker remains.",
        version: 11,
      },
      {
        kind: "behavior",
        summary:
          "Post-cleanup recovery holds worktree coordination from final verification through audit, deterministic stale-claim retirement, and lease removal; its immutable before/after plan makes crash retry safe, but it still cannot move refs, remove worktrees or branches, change provider state, push, merge, or deploy, and linked or non-regular audit event files are rejected.",
        version: 11,
      },
      {
        kind: "behavior",
        summary:
          "Authors in separate prepared or claimed worktrees can keep editing, generating files, formatting, testing, staging, and committing at the same time; the short global lock is only for shared integration work such as target movement, commit integration, push, proposal or merge, deploy, worktree or branch lifecycle, and cleanup.",
        version: 11,
      },
      {
        kind: "integration",
        summary:
          "A busy controller lock pauses only the named shared operation and never requires a repository-wide author pause, patch export, destructive cleanup, or lease-null handback; EPERM, EACCES, and EROFS identify a harness or file-system permission failure instead of another agent holding the lock.",
        version: 11,
      },
      {
        kind: "onboarding",
        summary:
          "When a compatible Simple Changelogs installation is available, Delegate when available is the recommended and default onboarding choice; when it is relevant but unavailable, Simple Changes explains the skill and asks explicit installation consent before offering setup now, after this shipment, or later, and it never installs or configures silently.",
        version: 11,
      },
      {
        kind: "integration",
        summary:
          "Delayed Simple Changelogs setup preserves current changelog work; if this shipment needs a release boundary now, the user must choose setup now or stop before release, and delegation, installation, or setup timing grants no version, release, publication, deployment, or data authority.",
        version: 11,
      },
      {
        kind: "onboarding",
        summary:
          "Before the main setup questions, Simple Changes detects existing private global personal defaults and asks whether to use them unchanged for this run; declining continues onboarding, while storage choices distinguish repository team policy, a private global personal fallback that explicitly updates or overwrites existing defaults, and run-only settings that write no policy file.",
        version: 11,
      },
    ],
    version: 11,
  },
];

export const inspectGuidanceUpdate = (
  policy: RepoPolicy | null,
  changelogCoordination: ChangelogCoordination
): GuidanceUpdateNotice => {
  const storedVersion = policy ? policy.guidance.version : null;
  const storedDisposition = policy ? policy.guidance.disposition : null;
  const pending =
    storedVersion === null
      ? []
      : GUIDANCE_UPDATES.filter((update) => update.version > storedVersion);
  const changes = pending.flatMap((update) => update.changes);
  const summaryBullets = (["behavior", "onboarding", "integration"] as const)
    .map((kind) =>
      pending
        .flatMap((update) => update.changes)
        .filter((change) => change.kind === kind)
        .map((change) => change.summary)
        .join(" ")
    )
    .filter(Boolean);
  const updateAvailable = changes.length > 0;
  const changelogReviewRelevant = pending.some(
    (update) => update.changelogReviewRelevant
  );
  const changelogHandoffAvailable =
    updateAvailable &&
    changelogReviewRelevant &&
    changelogCoordination.guidanceUpdate.status === "update-available";
  const actions: GuidanceUpdateAction[] = updateAvailable
    ? [
        "review-settings",
        "keep-current-settings",
        "defer",
        "view-release-notes",
      ]
    : [];
  if (changelogHandoffAvailable) {
    actions.splice(actions.length - 1, 0, "review-with-simple-changelogs");
  }
  let changelogHandoffReason =
    "No Simple Changes update requires a changelog-workflow handoff.";
  if (
    updateAvailable &&
    changelogReviewRelevant &&
    !changelogCoordination.capabilityAvailable
  ) {
    changelogHandoffReason =
      "Simple Changelogs was not discovered, so no changelog-history review is offered.";
  } else if (updateAvailable && changelogReviewRelevant) {
    changelogHandoffReason =
      "Simple Changelogs is installed and current, unconfigured, or its update status could not be proven; no companion update review is offered.";
  }
  if (changelogHandoffAvailable) {
    changelogHandoffReason =
      "Simple Changelogs is present and owns any review of its settings or existing release notes.";
  }
  return {
    actionDescriptions: {
      defer:
        "Pause this update decision without changing settings; the same guidance version remains unresolved until explicitly acknowledged.",
      "keep-current-settings":
        "Keep existing choices after reviewing the practical changes and named defaults for every new setting.",
      "review-settings":
        "Recommended: explain every new ability and affected setting, including consequences and safety boundaries, before choosing values.",
      "review-with-simple-changelogs":
        "Review both skills through their owner-controlled walkthroughs when both have updates.",
      "view-release-notes":
        "Show the detailed released changes read-only before making a settings decision.",
    },
    actions,
    changelogHandoff: {
      available: changelogHandoffAvailable,
      owner: changelogHandoffAvailable ? "simple-changelogs" : null,
      reason: changelogHandoffReason,
    },
    changes,
    currentVersion: CURRENT_GUIDANCE_VERSION,
    headline: "**Simple Changes has recently been updated.**",
    recommendedAction: "review-settings",
    releaseNotes: {
      available: true,
      command: "simple-changes release-notes",
      label: "View detailed Simple Changes release notes",
    },
    status: updateAvailable ? "update-available" : "current",
    storedDisposition,
    storedVersion,
    summaryBullets,
    walkthroughQuestion:
      "Would you like me to walk you through all recent updates to the skill?",
  };
};

export const acknowledgeGuidanceUpdate = (
  policy: RepoPolicy,
  disposition: RepoPolicy["guidance"]["disposition"]
): RepoPolicy => ({
  ...policy,
  guidance: {
    disposition,
    version: CURRENT_GUIDANCE_VERSION,
  },
});
