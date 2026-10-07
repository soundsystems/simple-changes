import type { ChangelogCoordination, RepoPolicy } from "./types.ts";

export const CURRENT_GUIDANCE_VERSION = 27;

export type GuidanceUpdateAction =
  | "review-settings"
  | "expanded-walkthrough"
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
  presentationOrder: readonly [
    "required-answers",
    "recommended-changes",
    "summary",
    "actions",
  ];
  recommendedAction: GuidanceUpdateAction | null;
  recommendedChanges: GuidanceUpdateQuestion[];
  releaseNotes: {
    available: true;
    command: "simple-changes release-notes";
    label: "View detailed Simple Changes release notes";
  };
  requiredAnswers: GuidanceUpdateQuestion[];
  status: "current" | "update-available";
  storedDisposition: RepoPolicy["guidance"]["disposition"] | null;
  storedVersion: number | null;
  summaryBullets: string[];
  walkthroughQuestion: string;
}

export interface GuidanceUpdateQuestion {
  choices: Array<{
    description: string;
    label: string;
    recommended: boolean;
    value: string;
  }>;
  id: string;
  question: string;
  reason: string;
  setting: string;
}

interface GuidanceUpdateDefinition {
  changelogReviewRelevant: boolean;
  changes: GuidanceUpdateNotice["changes"];
  noticeBullets?: Array<{ priority: number; summary: string }>;
  requiredAnswers?: GuidanceUpdateQuestion[];
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
    noticeBullets: [
      {
        priority: 100,
        summary:
          "Cleanup removes only work proven safe and reports unfinished cleanup instead of calling the shipment complete.",
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
    noticeBullets: [
      {
        priority: 70,
        summary:
          "Routine updates are shorter, while technical details remain available when they affect safety or a decision.",
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
    noticeBullets: [
      {
        priority: 95,
        summary:
          "GitLab shipping records its starting branches and MRs so later changes and final cleanup can be verified honestly.",
      },
      {
        priority: 90,
        summary:
          "Agents can keep working in separate claimed worktrees while shared shipping steps stay coordinated.",
      },
    ],
    version: 11,
  },
  {
    changelogReviewRelevant: false,
    changes: [
      {
        kind: "onboarding",
        summary:
          "Installed-update prompts now ask any genuinely required multiple-choice questions first, with the recommended answer and consequence shown before any walkthrough choice.",
        version: 12,
      },
      {
        kind: "behavior",
        summary:
          "When no answer is required, Simple Changes says so plainly, recommends continuing with current settings, and keeps the default update summary short; expanded explanations and full release notes remain optional.",
        version: 12,
      },
    ],
    noticeBullets: [
      {
        priority: 110,
        summary:
          "Any new required answers now appear first as short multiple-choice questions with a recommended answer.",
      },
      {
        priority: 105,
        summary:
          "If nothing needs your decision, the update says so and keeps the walkthrough brief; expanded details stay optional.",
      },
    ],
    version: 12,
  },
  {
    changelogReviewRelevant: false,
    changes: [
      {
        kind: "behavior",
        summary:
          "Public shipment receipts now finish with exact-version customer notes as Markdown blockquotes under customer-facing surface headings, after operational results and blockers.",
        version: 13,
      },
      {
        kind: "behavior",
        summary:
          "Temporary deployment checkouts are run-created cleanup artifacts, and stale missing-retention bookkeeping is reconciled without another confirmation only when current Git evidence proves the checkout fully target-contained and unclaimed.",
        version: 13,
      },
    ],
    noticeBullets: [
      {
        priority: 115,
        summary:
          "Shipment summaries now separate operational receipts from concise customer notes rendered as quoted release-note blocks.",
      },
      {
        priority: 110,
        summary:
          "Proven target-contained temporary checkout cleanup no longer asks for a redundant confirmation.",
      },
    ],
    version: 13,
  },
  {
    changelogReviewRelevant: false,
    changes: [
      {
        kind: "behavior",
        summary:
          "Multiple unchanged preserved-checkout handoffs with stale coordination claims can now be rebound one at a time without deadlocking each other; exact paused evidence remains mandatory and every non-stale violation still blocks.",
        version: 14,
      },
    ],
    noticeBullets: [
      {
        priority: 115,
        summary:
          "Multiple unchanged stale checkout handoffs can now be repaired sequentially while unique or unverified work remains blocked.",
      },
    ],
    version: 14,
  },
  {
    changelogReviewRelevant: false,
    changes: [
      {
        kind: "behavior",
        summary:
          "Close-only legacy cleanup can now finish while unrelated active worktree claims remain preserved when two ordered claim inventories match exactly; any claim drift still blocks recovery.",
        version: 15,
      },
    ],
    noticeBullets: [
      {
        priority: 115,
        summary:
          "Stable unrelated worktree claims no longer prevent legacy cleanup closure, while any changed claim inventory still blocks.",
      },
    ],
    version: 15,
  },
  {
    changelogReviewRelevant: false,
    changes: [
      {
        kind: "behavior",
        summary:
          "Close-only recovery can now reconcile an absent run-created checkout reclassified as preserved only when its audited baseline is contained in the finalized target; every nonmatching or unverifiable case still blocks.",
        version: 16,
      },
    ],
    noticeBullets: [
      {
        priority: 120,
        summary:
          "Proven target-contained run-created checkout artifacts no longer strand legacy cleanup, while unverifiable or unique work remains blocked.",
      },
    ],
    version: 16,
  },
  {
    changelogReviewRelevant: false,
    changes: [
      {
        kind: "behavior",
        summary:
          "Relinquished integration loops now require an explicit Resume, and their existing author/worktree scope stays frozen so a later shipment cannot silently reuse the old controller.",
        version: 17,
      },
      {
        kind: "integration",
        summary:
          "A resumed controller can finish registered work, reconciliation, deployment, cleanup, and closure, but must close the old loop before preparing authors for another shipment.",
        version: 17,
      },
    ],
    noticeBullets: [
      {
        priority: 125,
        summary:
          "Relinquished controllers can finish their existing shipment without accumulating authors and worktrees from later shipments.",
      },
    ],
    version: 17,
  },
  {
    changelogReviewRelevant: false,
    changes: [
      {
        kind: "behavior",
        summary:
          "Ready work blocked by another active shipping task now offers an explicit choice between an approved handoff into that shipment and a separate shipment afterward.",
        version: 18,
      },
      {
        kind: "integration",
        summary:
          "Cross-task ready-work receipts preserve exact work and request integration without silently contacting another task or granting additional shipping authority.",
        version: 18,
      },
    ],
    noticeBullets: [
      {
        priority: 130,
        summary:
          "Finished work can be offered to the active shipping task with your approval or kept for a separate shipment afterward.",
      },
    ],
    version: 18,
  },
  {
    changelogReviewRelevant: false,
    changes: [
      {
        kind: "onboarding",
        summary:
          "Setup now records `proposalScheduling` as balanced, consecutive, or parallel; existing policies without the setting use the balanced default, and prompts use forge-specific PR or MR terminology.",
        version: 19,
      },
      {
        kind: "integration",
        summary:
          "Parallel authors remain isolated in claimed worktrees, while cleanup and remote coordination stay bound to the active shipment controller.",
        version: 19,
      },
    ],
    noticeBullets: [
      {
        priority: 135,
        summary:
          "The new `proposalScheduling` setting defaults existing policies to balanced scheduling and uses the detected forge's terminology.",
      },
    ],
    version: 19,
  },
  {
    changelogReviewRelevant: false,
    changes: [
      {
        kind: "behavior",
        summary:
          "Stale worktree claims can now be taken over with exact approval evidence, and read-only equivalence checks show whether inherited work is contained in the target.",
        version: 20,
      },
      {
        kind: "integration",
        summary:
          "Relinquished or frozen shipment loops whose obligated work is already target-contained can close through an audited target-equivalent recovery path without deleting preserved work.",
        version: 20,
      },
    ],
    noticeBullets: [
      {
        priority: 140,
        summary:
          "Inherited stale shipment state now has audited recovery paths that preserve unique or unverifiable work.",
      },
    ],
    version: 20,
  },
  {
    changelogReviewRelevant: false,
    changes: [
      {
        kind: "integration",
        summary:
          "An active or resumed controller can re-baseline its worktree manifest with exact user approval, registering worktrees that appeared after loop start as preserved and untouched so a busy repository no longer deadlocks the run or its recovery paths.",
        version: 21,
      },
      {
        kind: "behavior",
        summary:
          "Loop status now names the exact next recoverable command, a standalone audited cleanup pass removes proven-contained worktrees when no loop record exists, a read-only index refresh re-syncs cached editor and desktop worktree views, and equivalence reports carry advisory residue hints for unmatched work.",
        version: 21,
      },
      {
        kind: "integration",
        summary:
          "Stale-claim takeover now judges lease protection by controller lifecycle: a relinquished run's registered paths no longer freeze claim recovery, while active loops and adopted claim linkages stay protected.",
        version: 21,
      },
    ],
    noticeBullets: [
      {
        priority: 145,
        summary:
          "Stale opening manifests, orphaned worktrees, and stuck loops now resolve through approved re-baseline, standalone cleanup, and next-command status guidance.",
      },
    ],
    version: 21,
  },
  {
    changelogReviewRelevant: true,
    changes: [
      {
        kind: "onboarding",
        summary:
          "Setup now records `proposalSignatures` as agent-and-version or none; existing policies without the setting default to agent-and-version, so agents append their model name and version to every PR or MR they author, review, or merge.",
        version: 22,
      },
      {
        kind: "behavior",
        summary:
          "A worktree claim is now released by its owner, by a proceeding completed-work handoff, or by finalization evidence when the controller's own claimed work is contained in the target or the claimed directory no longer exists; every release records its reason.",
        version: 22,
      },
      {
        kind: "integration",
        summary:
          "When changelog work is relevant and Simple Changelogs is not installed, setup offers to install it and asks whether its own setup runs now, after this shipment, or later; the CMS-only distribution is discovered and reported as not applicable for release delegation.",
        version: 22,
      },
      {
        kind: "behavior",
        summary:
          "`release-gate` decides each public release boundary from the delegated request and receipt, and `release-delivery` composes the delivery receipt from the verified changelog receipt and the production deployment receipt instead of hand-copied fields.",
        version: 22,
      },
    ],
    noticeBullets: [
      {
        priority: 150,
        summary:
          "The new `proposalSignatures` setting defaults to signing every PR or MR an agent authors, reviews, or merges with its model name and version; finished worktree claims now release themselves at handoff and finalization.",
      },
    ],
    version: 22,
  },
  {
    changelogReviewRelevant: false,
    changes: [
      {
        kind: "integration",
        summary:
          "A finished author can release its claim with `worktree release --ready-receipt <file>`, recording scope, checks, release impact, migrations, and deployment constraints against the exact clean head; every controller reads each receipt and its freshness in `worktree status --json` without messaging the author.",
        version: 23,
      },
      {
        kind: "behavior",
        summary:
          "Any agent can add a shipment hold with `hold add` that delays or halts merges, deployments, or migrations. `loop verify --for`, `hold check --for`, and `migration apply` honor it; a waiver binds one run with user approval, a halt needs an explicit override, and `hold publish` shares a hold with other clones through `refs/simple-changes/holds/`.",
        version: 23,
      },
    ],
    noticeBullets: [
      {
        priority: 155,
        summary:
          "Agents in different harnesses can now hand off ready work and hold a shipment through shared repository state instead of messaging each other; controllers run `loop verify --for merge`, `--for deploy`, or `--for migrations` before those steps.",
      },
    ],
    version: 23,
  },
  {
    changelogReviewRelevant: false,
    changes: [
      {
        kind: "behavior",
        summary:
          'A controller that ends its turn on a decision the run needs pauses it with `loop finalize --awaiting-user "<question>"`: the run relinquishes, records the questions, exits zero, and hands them to the controller that resumes it.',
        version: 24,
      },
      {
        kind: "integration",
        summary:
          "An optional user-level Stop hook, installed with `harness stop-hook --write` after the user agrees, blocks a Claude Code or Codex session from ending its turn while it still controls an active run; initialization reports whether it is installed, and guard, exec, and verify output repeat the finalize step.",
        version: 24,
      },
      {
        kind: "behavior",
        summary:
          "A run whose harness session process has exited is stale after ten quiet minutes, and an unprovable owner becomes stale after two quiet hours instead of four; stale recovery archives the complete lease, and a runtime older than the target branch's copy is reported before shipping.",
        version: 24,
      },
    ],
    noticeBullets: [
      {
        priority: 160,
        summary:
          "Agents that stop to ask you something now pause their run with `loop finalize --awaiting-user`, and an optional Stop hook keeps a session from ending its turn while it still controls a shipment.",
      },
    ],
    version: 24,
  },
  {
    changelogReviewRelevant: false,
    changes: [
      {
        kind: "behavior",
        summary:
          "Proposal bodies now follow `references/change-requests.md#body-shape`: a Summary with the smallest view that makes the change clear, Evidence with a before, an after, and the checks run, and a Merge danger door and blast radius; a repository's own template is filled first and the signature stays last.",
        version: 25,
      },
      {
        kind: "behavior",
        summary:
          "An agent's independent review now pins exact base and head revisions and a non-empty diff, then reports two axes that are never merged or reranked: Standards cites the repository rule for each finding, and Spec quotes the issue or spec for missing, unrequested, or wrong behavior, or `no spec available`.",
        version: 25,
      },
      {
        kind: "behavior",
        summary:
          "After creating or updating a proposal, agents now check the stored description with `simple-changes proposal audit` (real line breaks, the body-shape or repository-template sections, a valid Merge danger door and blast radius, and a final signature block); `fork create` now describes a new fork as its repository's replacement for the global skill, and a fork installs the turn-end guard from the global copy.",
        version: 25,
      },
    ],
    noticeBullets: [
      {
        priority: 165,
        summary:
          "Proposal bodies now follow one shape with a Summary, Evidence, and a Merge danger door, and agent reviews report Standards and Spec findings on separate axes; existing proposals change only when next updated.",
      },
    ],
    version: 25,
  },
  {
    changelogReviewRelevant: false,
    changes: [
      {
        kind: "onboarding",
        summary:
          "`.simple-changes.json` accepts an optional `execGuard` argv, absent by default: it runs with the command appended before every `loop exec` child, and any nonzero exit refuses the command before it starts. It is repository code that runs with the agent's permissions; personal preferences never supply one, and setup and `acknowledge-update` keep a saved guard unchanged.",
        version: 26,
      },
      {
        kind: "behavior",
        summary:
          "`loop archive-recorded` archives, with named user approval, a frozen run that already recorded its shipment outcome but cannot finish; its `archived-unfinished` record never counts as delivery, and `loop status` and `loop replan-status` name it where `loop replan` refuses.",
        version: 26,
      },
      {
        kind: "behavior",
        summary:
          "`loop record-outcome --approved-by --approval-reference` accepts a user-approved preserved-source override for a claimed author's checkout whose work shipped in an independently reviewed, equivalent form; finalization keeps that checkout only while nothing moved, and a fork's setup now names the fork in the managed instruction block.",
        version: 26,
      },
    ],
    noticeBullets: [
      {
        priority: 170,
        summary:
          "A repository can now add an `execGuard` check that must pass before `loop exec` runs a command, such as a merge before hosted CI passes, and a recorded run that cannot finish can be archived with your approval through `loop archive-recorded`.",
      },
    ],
    version: 26,
  },
  {
    changelogReviewRelevant: true,
    changes: [
      {
        kind: "integration",
        summary:
          "Changelog negotiation adds request v3 and receipt v4, whose release record names the release's Git tag, and now pairs each request version only with receipts it may advertise, so request v1 never meets receipt v3; Simple Changelogs before 0.2.0 negotiates exactly as before and names no tag.",
        version: 27,
      },
      {
        kind: "behavior",
        summary:
          "`release-tag` publishes the tag a receipt v4 names: `--dry-run` before the release merge stops it when the name is taken, and once the release crosses its public boundary it builds an unsigned annotated tag on the verified commit, pushes only that tag to the run's single-URL target remote, reads it back, and never moves, replaces, or deletes a tag; final verification requires it, and a blocked tag stops the deployment.",
        version: 27,
      },
      {
        kind: "behavior",
        summary:
          "A tag push needs the release's existing approval plus `--tag-automation-authorized` after the controller lists what CI a push of that tag can start; deploy and migration holds block it, Sync never tags, and `update-local-forks` tries the `v<version>` tag first but still proves a byte-identical tree on the branch's first-parent history.",
        version: 27,
      },
    ],
    noticeBullets: [
      {
        priority: 175,
        summary:
          "Releases can now get a Git tag on their exact commit: when Simple Changelogs names one, Simple Changes checks the name before merging and pushes the tag when the release goes out, under the approval it already has. Nothing changes until Simple Changelogs asks whether to tag.",
      },
    ],
    version: 27,
  },
];

const recommendedActionFor = (
  requiredAnswers: GuidanceUpdateQuestion[],
  recommendedChanges: GuidanceUpdateQuestion[]
): GuidanceUpdateAction | null => {
  if (requiredAnswers.length > 0) {
    return null;
  }
  if (recommendedChanges.length > 0) {
    return "review-settings";
  }
  return "keep-current-settings";
};

const actionsForGuidanceUpdate = (
  updateAvailable: boolean,
  recommendedChanges: GuidanceUpdateQuestion[]
): GuidanceUpdateAction[] => {
  if (!updateAvailable) {
    return [];
  }
  const firstActions: GuidanceUpdateAction[] =
    recommendedChanges.length > 0
      ? ["review-settings", "keep-current-settings"]
      : ["keep-current-settings", "review-settings"];
  return [
    ...firstActions,
    "expanded-walkthrough",
    "view-release-notes",
    "defer",
  ];
};

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
  const noticeBullets = pending
    .flatMap((update) => update.noticeBullets ?? [])
    .sort((left, right) => right.priority - left.priority);
  const summaryBullets = (
    noticeBullets.length > 0
      ? noticeBullets.map((bullet) => bullet.summary)
      : changes.map((change) => change.summary)
  ).slice(0, 3);
  const requiredAnswers = pending.flatMap(
    (update) => update.requiredAnswers ?? []
  );
  const recommendedChanges: GuidanceUpdateQuestion[] = [];
  if (
    storedVersion !== null &&
    storedVersion < 11 &&
    policy?.changelogHandling !== "delegate-if-available" &&
    changelogCoordination.capabilityAvailable
  ) {
    recommendedChanges.push({
      choices: [
        {
          description:
            "Use the compatible Simple Changelogs workflow when available; otherwise preserve and report changelog work.",
          label: "Delegate when available (Recommended)",
          recommended: true,
          value: "delegate-if-available",
        },
        {
          description:
            "Never change changelog destinations; preserve the work and report it.",
          label: "Preserve and report",
          recommended: false,
          value: "preserve-and-report",
        },
        {
          description: "Ask before handing changelog work to another skill.",
          label: "Ask before delegating",
          recommended: false,
          value: "ask",
        },
      ],
      id: "recommended-changelog-handling",
      question: "How should changelog work be handled?",
      reason:
        "A compatible Simple Changelogs installation is available, so delegation is now the recommended answer.",
      setting: "changelogHandling",
    });
  }
  const updateAvailable = changes.length > 0;
  const changelogReviewRelevant = pending.some(
    (update) => update.changelogReviewRelevant
  );
  const changelogHandoffAvailable =
    updateAvailable &&
    changelogReviewRelevant &&
    changelogCoordination.guidanceUpdate.status === "update-available";
  const recommendedAction = recommendedActionFor(
    requiredAnswers,
    recommendedChanges
  );
  const actions = actionsForGuidanceUpdate(updateAvailable, recommendedChanges);
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
      "expanded-walkthrough":
        "Explain every intervening behavior, example, consequence, setting, and safety boundary.",
      "keep-current-settings":
        "Acknowledge the update and continue with the existing confirmed choices.",
      "review-settings":
        "Show the short practical walkthrough: required answers, recommended changes, and the main behind-the-scenes improvements.",
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
    presentationOrder: [
      "required-answers",
      "recommended-changes",
      "summary",
      "actions",
    ],
    recommendedAction,
    recommendedChanges,
    releaseNotes: {
      available: true,
      command: "simple-changes release-notes",
      label: "View detailed Simple Changes release notes",
    },
    requiredAnswers,
    status: updateAvailable ? "update-available" : "current",
    storedDisposition,
    storedVersion,
    summaryBullets,
    walkthroughQuestion: "How would you like to continue?",
  };
};

/**
 * The guidance record an acknowledgement saves. Only these two values change
 * in the saved policy; see `writeGuidanceAcknowledgement`.
 */
export const acknowledgedGuidance = (
  disposition: RepoPolicy["guidance"]["disposition"]
): RepoPolicy["guidance"] => ({
  disposition,
  version: CURRENT_GUIDANCE_VERSION,
});
