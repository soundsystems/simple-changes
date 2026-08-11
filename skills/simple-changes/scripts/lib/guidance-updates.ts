import type { ChangelogCoordination, RepoPolicy } from "./types.ts";

export const CURRENT_GUIDANCE_VERSION = 3;

export type GuidanceUpdateAction =
  | "review-settings"
  | "keep-current-settings"
  | "defer"
  | "view-release-notes"
  | "review-with-simple-changelogs";

export interface GuidanceUpdateNotice {
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
  releaseNotes: {
    available: true;
    command: "simple-changes release-notes";
    label: "View detailed Simple Changes release notes";
  };
  status: "current" | "update-available";
  storedDisposition: RepoPolicy["guidance"]["disposition"] | null;
  storedVersion: number | null;
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
  const updateAvailable = changes.length > 0;
  const changelogReviewRelevant = pending.some(
    (update) => update.changelogReviewRelevant
  );
  const changelogHandoffAvailable =
    updateAvailable &&
    changelogReviewRelevant &&
    changelogCoordination.capabilityAvailable;
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
  if (updateAvailable && changelogReviewRelevant) {
    changelogHandoffReason =
      "Simple Changelogs was not discovered, so no changelog-history review is offered.";
  }
  if (changelogHandoffAvailable) {
    changelogHandoffReason =
      "Simple Changelogs is present and owns any review of its settings or existing release notes.";
  }
  return {
    actions,
    changelogHandoff: {
      available: changelogHandoffAvailable,
      owner: changelogHandoffAvailable ? "simple-changelogs" : null,
      reason: changelogHandoffReason,
    },
    changes,
    currentVersion: CURRENT_GUIDANCE_VERSION,
    releaseNotes: {
      available: true,
      command: "simple-changes release-notes",
      label: "View detailed Simple Changes release notes",
    },
    status: updateAvailable ? "update-available" : "current",
    storedDisposition,
    storedVersion,
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
