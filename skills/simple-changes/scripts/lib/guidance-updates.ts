import type { ChangelogCoordination, RepoPolicy } from "./types.ts";

export const CURRENT_GUIDANCE_VERSION = 8;

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
  const newestPending = pending.at(-1);
  const summaryBullets = newestPending
    ? newestPending.changes.slice(0, 3).map((change) => change.summary)
    : [];
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
