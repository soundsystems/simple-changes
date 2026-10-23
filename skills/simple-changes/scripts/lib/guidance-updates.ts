import type { AuthoringQuestionState, DetectedHarness } from "./authoring.ts";
import type { ChangelogCoordination, RepoPolicy } from "./types.ts";

export const CURRENT_GUIDANCE_VERSION = 33;

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

/**
 * What the notice may depend on beyond the saved policy: current detection,
 * the authoring question state (computed from validated sidecars, never from
 * the acknowledgement), and questions whose wording depends on detection.
 */
export interface GuidanceUpdateContext {
  authoringQuestion?: {
    models: AuthoringQuestionState;
    review: AuthoringQuestionState;
  };
  detectedHarnesses?: DetectedHarness[];
  questions?: Record<string, GuidanceUpdateQuestion>;
}

// A required answer that applies only while its predicate holds; its wording
// comes from the context, so the notice asks it first when it is pending and
// otherwise lists the capability without a question.
interface ConditionalGuidanceAnswer {
  id: string;
  when: "authoring-question-pending";
}

const answerApplies = (
  answer: ConditionalGuidanceAnswer,
  context: GuidanceUpdateContext
): boolean =>
  answer.when === "authoring-question-pending" &&
  context.authoringQuestion?.review === "pending";

interface GuidanceUpdateDefinition {
  changelogReviewRelevant: boolean;
  changes: GuidanceUpdateNotice["changes"];
  noticeBullets?: Array<{ priority: number; summary: string }>;
  requiredAnswers?: Array<GuidanceUpdateQuestion | ConditionalGuidanceAnswer>;
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
          "Changelog negotiation adds request v3 and receipt v4, whose release record names the release's Git tag, and now pairs each request version only with receipts it may advertise, so request v1 never meets receipt v3; Simple Changelogs before 0.25.0 negotiates exactly as before and names no tag.",
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
  {
    changelogReviewRelevant: false,
    changes: [
      {
        kind: "onboarding",
        summary:
          "An optional authoring sidecar, `.simple-changes-authoring.json` or a personal `authoring.json`, records which model writes proposal descriptions and merge messages and who performs independent reviews in each coding agent the owner uses; it is a preference only, so it grants no authority and never changes who signs. Setup asks **Which coding agents do you use?**, one model question per agent, and, with two or more agents detected, **Who should perform independent reviews?**; `setup --authoring <json-or-@path> --scope <repository|personal> --confirm` records an answer without touching the policy.",
        version: 28,
      },
      {
        kind: "behavior",
        summary:
          "Agents attest every commit with `author attest` (with `--replays` after a rebase, cherry-pick, or squash) and run `proposal record-authors` after creating or updating a proposal. `proposal record-review` accepts a returned review only when the head's commits are attributed or waived with `proposal waive-coverage`, the reviewer is a separate agent or session from every author, and, for an adversarial review, a different agent or model; after findings, later reviews run at least at the recorded escalation effort.",
        version: 28,
      },
      {
        kind: "integration",
        summary:
          "`initialize` reports detected agents, both authoring files, the per-question state, the effective roles with each field's source, and the resolved reviewer, which `--proposal <id> --head <sha>` checks against that head's recorded authors; the pre-ship brief names the reviewer and its source. A run-only answer is applied with `--authoring-request <json-or-@path>` on `initialize`, `proposal record-review`, and `loop start --mode resume`: it is never saved, and it can make the review gate adversarial but never loosen a saved setting.",
        version: 28,
      },
      {
        kind: "behavior",
        summary:
          "Released, handed-off, preserved, adopted, and retained worktrees are pinned to their recorded commits: while any is pinned, `loop exec` runs only Git and provider merges that name their commit (`glab mr merge <iid> --sha <commit>`, optionally with `-R <project>`), refuses before Git starts any command that could integrate a later commit, and prints the same command with the recorded commit ID or the claim, pause, and accept steps; `loop verify --for merge` reports a registered branch that moved.",
        version: 28,
      },
      {
        kind: "integration",
        summary:
          "`remote-inventory build` builds the opening and final remote inventory receipts from fetched provider pages, with a read-only GitLab reference fetcher; `loop draft-outcome` drafts the shipment outcome from Git with placeholders that `loop record-outcome` refuses until each is replaced; and `status --all` shows every local repository's runs, claims, holds, ready work, pending notices, and forks without writing, fetching, or locking.",
        version: 28,
      },
      {
        kind: "behavior",
        summary:
          "SKILL.md now fits in the first 5,000 tokens a harness keeps after compaction: the request table, invariants, and reference router come first, every reference and provider reference is linked directly, and the recovery paths (lock and stale-lease recovery, takeover, the released-claim pause and accept steps, re-baseline, close-equivalent, lease-less prune, replan, and archive-recorded) moved unchanged into `references/recovery.md`, which agents read when `loop status`, `loop verify`, or finalization reports trouble.",
        version: 28,
      },
      {
        kind: "integration",
        summary:
          "The installed skill carries the release notes of the last six guidance versions; `release-notes --version` for an older release prints its link in the full changelog with the notices of the guidance versions it introduced and exits 6 instead of failing, and `update-local-forks` still verifies an older release's tree after its notes leave the window.",
        version: 28,
      },
    ],
    noticeBullets: [
      {
        priority: 180,
        summary:
          "You can now choose which model writes proposals and who reviews them in each coding agent you use, and a review from a different agent or model is checked against the recorded author of every commit. When two or more agents are detected, this update asks who should perform independent reviews.",
      },
      {
        priority: 180,
        summary:
          "Ship runs now merge exactly the commit each released or preserved worktree was recorded at: while such worktrees wait, `loop exec` runs only Git and provider merges that name their commit, and refuses any merge that could pick up a later commit, printing the commit-ID command or the recovery steps instead.",
      },
      {
        priority: 180,
        summary:
          "Simple Changes keeps its core rules within what an agent remembers after a long conversation and reads its recovery steps only when a run reports trouble; release notes older than the last six guidance versions open from a link to the full changelog.",
      },
    ],
    requiredAnswers: [
      { id: "authoring-review", when: "authoring-question-pending" },
    ],
    version: 28,
  },
  {
    changelogReviewRelevant: false,
    changes: [
      {
        kind: "behavior",
        summary:
          "`loop start` and `prepare-agent` report a private `workDir` outside every checkout and the Git common directory, kept for its agent and run and bound to the run under the loop locks; agents keep the files they hand to Simple Changes there (provider pages, receipts, proposal bodies, and decision files) instead of folders beside the project. A clean `loop finalize` or `loop end` removes the run's directories and a blocked or preserved run keeps them; `simple-changes workdir --agent-id <id>` prints one and `workdir remove <path>` deletes one by hand.",
        version: 29,
      },
      {
        kind: "onboarding",
        summary:
          "`setup` and `initialize` accept `--scratch-file-rule add|leave`: `add` writes a separate managed block to AGENTS.md or CLAUDE.md telling every agent to keep scratch files, proof bundles, and handoff notes out of project folders and to delete them when the task ends. Nothing changes unless you add it, non-interactive setup leaves it out, and nested or crossed managed blocks are refused.",
        version: 29,
      },
      {
        kind: "behavior",
        summary:
          "`update-local-forks` makes a file a conflict when upstream moved code out of it, meaning a significant line removed there appears among lines added to another upstream file, and the fork changed or omits that file, so a fork's edit to moved code is never dropped silently; the reason and sidecar name the moves, the new file is still written with a note pointing back, an untouched fork gets the same plan as before, and fork checks that search moved text get an advisory note naming its new file.",
        version: 29,
      },
      {
        kind: "integration",
        summary:
          "`scripts/lib/loop-lease.ts` is split into ten command-group modules behind a facade that re-exports the same 86 names, with no behavior change; fork checks that read its text should read `loop-lease*.ts`.",
        version: 29,
      },
    ],
    noticeBullets: [
      {
        priority: 185,
        summary:
          "Agents now keep the files they pass to Simple Changes in a private temporary work directory, and a run that finishes cleanly deletes it, so runs stop leaving folders next to your projects.",
      },
      {
        priority: 185,
        summary:
          "Setup can also add an optional rule to AGENTS.md or CLAUDE.md that keeps every agent's scratch files out of your project folders.",
      },
      {
        priority: 180,
        summary:
          "Updating a fork now stops with a conflict, instead of dropping your change, when upstream moved code you edited into another file.",
      },
    ],
    version: 29,
  },
  {
    changelogReviewRelevant: false,
    changes: [
      {
        kind: "behavior",
        summary:
          "`author attest --complete-identity` lets the agent that made an attestation missing its instance or model complete it from the same executing session, harness, and agent id; the ledger keeps every attestation and adds an optional `completions` record naming the ones completed, which then stop leaving independence or diversity unknown, while any reviewer they ruled out as the same executor stays ruled out. It is refused for a replay, without an executing session, when nothing is missing, and when another instance or model already appears under that session and agent id, and such a record appearing later voids it. A head whose effective authors change gets a new authors digest, so earlier reviews of it stop counting, and a runtime before 0.30.0 reads a ledger holding a completion as malformed.",
        version: 30,
      },
      {
        kind: "integration",
        summary:
          "`SKILL.md` puts `## Core workflow` directly after the mode table; the `release-tag` rule moved to `references/changelog-coordination.md` under Release tags, and a branch-audit paragraph that repeated `references/replacement-lineage.md` was removed. Forks that edit SKILL.md see a conflict on their next update and should drop their own copies of those two paragraphs while merging.",
        version: 30,
      },
    ],
    noticeBullets: [
      {
        priority: 180,
        summary:
          "A review blocked because an author's earlier attestation left out its model or instance can now be unblocked: that same author completes the attestation with `author attest --complete-identity`.",
      },
    ],
    version: 30,
  },
  {
    changelogReviewRelevant: false,
    changes: [
      {
        kind: "behavior",
        summary:
          "Adversarial review compares canonical model IDs, the lowercase names a harness reports such as `model-5-5`, exactly after folding case and one `provider/` prefix, and 0.30.1's interim display-name matching is gone. Within one harness a display name, an effort label, or a missing model on either side fails closed (`author-identity-missing`, `reviewer-identity-missing`, or, before dispatch, the new `reviewer-model-id-missing`) with a next step that says when each recovery applies; across harnesses a reported name is still enough. Record `author attest --agent` as a model ID and complete an earlier display-name attestation from the same session with `--complete-identity`; a completion stands only while no two records under its session, harness, and agent id disagree, and a runtime before 0.31.0 reads a ledger holding one that adds a model ID as malformed.",
        version: 31,
      },
      {
        kind: "behavior",
        summary:
          "A `proposal record-review` receipt may grade its findings with `severities` (`blocking`, `shouldFix`, and `nit` counts adding up to `findingsCount`). By default only blocking or should-fix findings, or ungraded ones, set the escalation floor, and `initialize --proposal <id> --head <sha>` reports `reviewer.loop`: the convergence check is due after 2 escalating rounds in a row, when the agent questions the approach if the findings sit in one area, and the round cap is reached after 4 rounds that follow the first escalating one without an accepted clean review, when it asks the user. A runtime before 0.31.0 reads a ledger holding `severities` as malformed.",
        version: 31,
      },
      {
        kind: "onboarding",
        summary:
          "Setup asks the review loop questions for every reviewer choice: the first review's effort (`high` recommended), when later reviews escalate (after blocking or should-fix findings, after any finding, or never), and when the agent stops to check with the user (after 2 rounds in a row or 4 more without a clean review, or never). The recommended answers record no `reviewLoop`, an absent `reviewLoop` means the recommended loop, so no existing setup is asked again, a run-only request only tightens it, and a runtime before 0.31.0 rejects a sidecar holding it. The reviewer model question accepts only a model ID that differs from the author's.",
        version: 31,
      },
      {
        kind: "onboarding",
        summary:
          "`setup` and `initialize` accept `--review-loop-rule add|leave`: `add` writes a separate managed block to an instruction file such as AGENTS.md telling agents how to run review rounds in Simple Changes runs with the configured review settings, naming no agent or model. Interactive setup offers it after the scratch-file rule and non-interactive setup leaves it out; `initialize` reports `reviewLoopRule` with a `refreshCommand` for a stale block, and `review-loop-rule refresh --instruction-file <path>` rewrites only that block.",
        version: 31,
      },
      {
        kind: "behavior",
        summary:
          "A worktree claim belongs to the harness session that made it, marked in its coordination event IDs. From any other session, or one that reports none, its agent ID cannot refresh, pause, detach, attach, or release it, record ready work or a handoff for it, attest through it, claim elsewhere while it is live, or claim a checkout whose latest claim came from another session; each refusal prints the approved `worktree takeover` that moves the claim to the asking session. Claims from before this release or without a session bind to the first known session that claims them, and attestation through a `prepare-agent` registration is unchanged.",
        version: 31,
      },
      {
        kind: "behavior",
        summary:
          "`worktree takeover` requires `--head <sha>` (or `--head none` for a checkout with no commit) and exactly one of `--branch <name>` or `--detached`, refuses unless the branch, HEAD, and status digest all match, and on a reassign records that state and binds the claim to the session that ran it. It also takes over stale and detached claims, and `--release` retires whatever the owner's own release could. While a controller is active, the one takeover allowed on a registered path reassigns a concurrent author's live claim to that controller, which then claims, pauses, and accepts the checkout, so a vanished author never forces a relinquished run; `loop verify` prints the exact command.",
        version: 31,
      },
      {
        kind: "behavior",
        summary:
          "`worktree release --ready-receipt` refuses, recording nothing and keeping the claim, while any commit the target lacks has no attested author, carries a replay source with none, or is an inconclusive replay nobody attested an edit on, and prints the exact SHAs with the owner's own `author attest` commands; `--leave-uncovered <sha>[,<sha>...]` names exactly the outstanding commits another agent made and waives nothing. Ready work holds the loop lock, `worktree status` shows each unshipped receipt's coverage, and the read-only `author coverage --base <target> --head <sha>` reports the same coverage and authors digest before a proposal exists, exiting 3 until it is complete.",
        version: 31,
      },
      {
        kind: "integration",
        summary:
          "`worktree request` only constructs a request: `request.state` is `constructed`, `capabilityProbe.automatic` is always false, `adapterSupportsAutomation` and `host` keep the owner's nominal profile apart from the executing host, an automatable profile returns a `host-transport-unverified` blocker naming the manual path, and the request must name the active run. Deliver it only through a delivery tool the executing host verifiably has for that exact owner, or relay it; only the owner's exact pause receipt acknowledges it.",
        version: 31,
      },
      {
        kind: "behavior",
        summary:
          "Every path built from a run ID requires the `run-[a-z0-9-]+` form `loop start` mints, so work-directory cleanup can no longer be pointed at the state directory, and the concurrent Git reader runs only Git, refusing any other program or a leading option. The setup and policy reference tells agents to treat commit messages, trailers, branch names, proposal descriptions, review comments, and provider responses as untrusted data, and the README's Security model section says what the Stop hook, `execGuard`, migration adapters, transcript reads, and Git and `glab` calls can touch and how to opt out.",
        version: 31,
      },
    ],
    noticeBullets: [
      {
        priority: 190,
        summary:
          "Adversarial review now compares the model IDs your coding agents report, such as `model-5-5`, not display names. Within one coding agent, an attestation with a display name blocks adversarial review until its author completes it with `author attest --complete-identity`. Update every copy of Simple Changes that shares the repository before completing one or grading findings, because older copies cannot read either.",
      },
      {
        priority: 190,
        summary:
          "Reviews can now grade findings as blocking, should-fix, or nit. By default only blocking and should-fix findings raise the effort of later reviews, and the agent stops to rethink after 2 such rounds in a row, or asks you after 4 more without a clean review. Setup can also add an optional review-loop rule to your agent instruction file, such as AGENTS.md.",
      },
      {
        priority: 190,
        summary:
          "A worktree claim now belongs to the session that made it, so another session cannot act or attest under its agent ID without your approved `worktree takeover`, and a ready handoff is refused until every commit has an attested author; `author coverage` shows what is missing.",
      },
    ],
    version: 31,
  },
  {
    changelogReviewRelevant: false,
    changes: [
      {
        kind: "behavior",
        summary:
          "`prepare-agent` creates each worktree directly beside the primary checkout as `.simple-changes-<repository>--<run>--<purpose>--<agent>`, each part reduced to lowercase letters, digits, and hyphens, so Git creates only that folder and Simple Changes creates no parent; it refuses, creating nothing, when anything holds the path, even a dangling link. Worktrees in the older `.simple-changes-worktrees/<repository>/` layout keep working by their recorded paths, and a preparation recorded there resumes only while its folder exists. Simple Changes never removes a worktree's parent folder: `loop finalize`, `loop close-equivalent`, `worktree cleanup`, and `prune` name an older-layout folder their removals left empty in non-blocking `notes`.",
        version: 32,
      },
      {
        kind: "behavior",
        summary:
          "Uncommitted work is preserved in Git, on its own branch with the owner's `worktree pause --disposition preserve-in-place` receipt. An unavoidable file copy goes in a read-only `preservation-copy` directory at the top of the agent's work directory with a `manifest.json`, and a clean `loop finalize` or `loop end`, and the next `loop start`, keep a work directory holding one and report the `chmod -R u+w` and `workdir remove` commands to run once the target or a pushed branch contains the work. The check is existence only, and the read-only bits stop an older runtime's cleanup only when it runs as an ordinary user.",
        version: 32,
      },
      {
        kind: "onboarding",
        summary:
          "The managed scratch-file rule also tells agents to preserve uncommitted work in Git rather than as loose copies, to keep an unavoidable file copy only in a read-only `preservation-copy` directory with its manifest until a pushed branch or the target contains the work, and to create worktrees where their brief or a Simple Changes run puts them, never in a folder made beside the repositories, removing with `rmdir` any such folder they made. Every block an earlier release wrote is now `stale`, and `initialize` offers `scratch-file-rule refresh --instruction-file <path>`, which rewrites only that block.",
        version: 32,
      },
      {
        kind: "behavior",
        summary:
          "After a run's shipment scope froze, `prepare-agent --purpose changelog --unit <unit ID>` adds a changelog-only author to a unit the frozen scope registers, without a new unit, a wider scope, or a new approval, bound in a `changelog-author/<run>.json` sidecar to the release surfaces the primary held when it was prepared. Any change it makes outside them, uncommitted, on its branch even after its checkout is removed, or in a commit it attested, is a `changelog-author-outside-release-surfaces` violation that keeps the unit stale, and stale for the run once attested; its checkout never becomes the controller's, and its attestation changes the authors digest, so earlier reviews stop counting. Older runtimes ignore the sidecar and reject `--unit`.",
        version: 32,
      },
      {
        kind: "behavior",
        summary:
          "An owner whose pause the controller accepted may release its claim with `worktree release` or `initialize --mode handoff` without pausing again: while the release recorded the checkout's exact state, which equals the accepted pause receipt and the registered baseline, and no newer claim holds it, the link stays current, and `coordination-claim-stale` otherwise names its cause. `worktree resume-ready` accepts the owner's receipt for a run an approved `loop replan` replaced while the checkout is unchanged, and prints the owner's `worktree pause` command when it refuses. A removal finalization recorded as completed stays accepted after the target moves, so a resumed run no longer reports its own removal as `missing-preserved-worktree`.",
        version: 32,
      },
      {
        kind: "behavior",
        summary:
          "A branch is recorded only by its exact name: claims, pauses, ready receipts, loop start, rebaseline, adoption, acceptance, `dispose-worktree`, `retain-worktree`, and a resumed `prepare-agent` preparation refuse a branch whose name is not valid UTF-8 or contains U+FFFD with exit 5, naming the checkout and writing nothing. Finalization reports it as a cleanup error, leaves that claim, registration, and checkout as they are, and never deletes such a branch; a release stays allowed but records no checkout state, and an older claim on such a branch is no longer admitted as a concurrent author. Records written before 0.32.0 keep their names until released or replaced.",
        version: 32,
      },
      {
        kind: "integration",
        summary:
          "The review ledger (root, attestations, completions, review attempts) and each role of a Simple Changes authoring sidecar accept an optional `extensions` object that readers keep without interpreting; a later release puts a field there only when a reader that ignores it can only be stricter, and an unknown key beside it asks to update the runtime. A file holding extensions must spell its JSON as Simple Changes writes it, or it reads as malformed; a ledger write keeps them byte for byte and refuses to drop or change them, and a sidecar write keeps their values but may change spacing. Nothing writes `extensions` yet, and runtimes before 0.32.0 reject a ledger or sidecar holding it.",
        version: 32,
      },
      {
        kind: "integration",
        summary:
          "The GitLab provider reference documents recovery of a passed hosted CI run whose publication failed: the repository adapter records a `partial` forge receipt naming the exact pipeline and attempt, and recovery re-checks that exact pipeline and republishes without dispatching another run or adopting an unrelated passing one; the GitHub reference points to the same contract. Core Simple Changes runs no CI.",
        version: 32,
      },
    ],
    noticeBullets: [
      {
        priority: 190,
        summary:
          "If you added the scratch-file rule to your agent instruction file, such as AGENTS.md, your copy is now out of date: the rule also keeps uncommitted work in Git and worktrees out of folders made beside your repositories. `initialize` reports it as stale and offers `scratch-file-rule refresh`, which rewrites only that block.",
      },
      {
        priority: 185,
        summary:
          "Agent worktrees now go directly beside your repository, so cleanup no longer leaves empty folders behind. Worktrees in the older `.simple-changes-worktrees` folder keep working, and Simple Changes never removes that folder for you; cleanup only names it once it is empty.",
      },
      {
        priority: 185,
        summary:
          "A run whose scope froze can now add an author that changes only your changelog files to a unit it already registered, with `prepare-agent --purpose changelog --unit <id>`; any other change by that author makes the unit stale.",
      },
      {
        priority: 180,
        summary:
          "The review ledger and authoring settings can now carry fields from newer Simple Changes versions. Nothing writes them yet, but copies older than 0.32.0 cannot read files that hold them, so keep every copy that shares a repository on 0.32.0 or later.",
      },
    ],
    version: 32,
  },
  {
    changelogReviewRelevant: false,
    changes: [
      {
        kind: "behavior",
        summary:
          "Every command checks Git's answer for the repository's common Git directory before it takes a lock or writes shared state, and refuses with exit 4 and a bounded `Diagnostics:` line, writing nothing, when the answer is empty, holds a NUL byte, names a missing path or the checkout itself, is not a repository's Git directory, or is one this checkout does not belong to. Every state directory under `<common Git directory>/simple-changes` is created one level at a time, refusing a symbolic link or non-directory at any level. A read-only Git question that always has an answer is asked again once when Git exits 0 with no output, then refused as retryable, and the exact-byte proof, the handoff file listing, and target tree reads tell a real empty listing from a lost answer and refuse the lost one.",
        version: 33,
      },
      {
        kind: "behavior",
        summary:
          "After a run's shipment scope froze, `loop hold-unit --unit <unit ID> --reason <text> --readiness-evidence \"<unit ID>: <evidence>\"` keeps one scoped unit out of the shipment, such as one review found not ready: without approval flags it only prints the exact observed source, claim, and target state with an observation digest, and with `--approved-by`, `--approval-reference`, and `--observation-digest` from a user who is neither the controller nor the claim owner it records an immutable hold, pins the held head at `refs/simple-changes/held/<run>/<unit>`, and adds a `heldUnits` key to that run's lease. The outcome and `loop draft-outcome` never report a held unit as delivered or target-equivalent, `loop finalize` lists it under `heldUnits` and leaves its checkout, branch, claim, and bytes untouched, `worktree cleanup` keeps a removed held checkout's claim, `loop retire-absent-worktree` refuses a held source, and `loop close-equivalent` and `loop recover-post-cleanup` refuse a held run. Runtimes before 0.33.0 refuse a lease holding `heldUnits`; runs without holds keep their lease unchanged.",
        version: 33,
      },
      {
        kind: "behavior",
        summary:
          "`loop record-outcome` accepts a user-approved `preservedSourceHandoff` on a `delivered` unit whose dirty source checkout, detached or on a branch, stays in place: it binds the original owner's claim and accepted `preserve-in-place` pause, the source's exact digest and entries read from the file system rather than Git status, the single-parent commit that copied those exact bytes into the final target, the independently reviewed target entries, and the approval given through `--approved-by` and `--approval-reference`, in its own `preserved-source-handoff/<run>.json` sidecar. The run then finalizes as verified delivery and leaves the source, its files, and its claim untouched; any mismatch refuses with exit 3 at record time or blocks completion later, and older runtimes cannot read the sidecar, so they refuse to finish, end, or archive such a run.",
        version: 33,
      },
      {
        kind: "behavior",
        summary:
          "`author attest`, `proposal record-authors`, `proposal record-review`, `proposal waive-coverage`, `loop record-scope`, `loop refresh-scope`, `loop record-outcome`, and `worktree release --ready-receipt` accept `--wait-lock [--timeout-ms <n>]` (default 60000, at most 600000) to wait while a live owner holds the loop lock and then run once, instead of exiting 5 at once. A wait never breaks, takes over, or recovers a lock, ends at once with exit 5 when the owner's process is gone on this host or the command runs inside the owner, such as inside `loop exec`, and on exit 5 reports `lockWait` with `executed: false` in `--json`. Without the flag nothing changes, and `initialize --mode preview` resolves the reviewer without taking the lock.",
        version: 33,
      },
      {
        kind: "behavior",
        summary:
          "An approved `loop replan` or `loop archive-recorded` survives a concurrent author's own verified claim release during the approval: `loop replan-status` stores the observation it returns, and when the current one differs, replan accepts the exact delta only when every difference is the claim owner's own `owner-release` or `handoff` of a live claim that recorded exactly the approved branch, head, and status digest, with source inventory and target unchanged, and records it in `replan-approval-delta.json` and the `approvalDelta` output. Any other difference refuses as before, now printing the delta for a fresh approval, and an approval observed by an older runtime still refuses because its observation is not on record.",
        version: 33,
      },
      {
        kind: "behavior",
        summary:
          "Read-only `reviewer room --would-author <harness id>/<model ID>`, with `--base` and `--head` or `--proposal` when the work exists, reports before an author is dispatched whether adversarial review stays possible at the effort required now and at the escalation effort, naming for each reviewer route the conflicting authors and the commits that introduced them. It exits 0 only for `open`, when the configured reviewer stays eligible and the controller reported a real run of that model at both efforts with `--verified-route <harness id>/<model ID>@<effort>`; `unverified`, `alternative-only`, `closed`, and `unknown` exit 3. A display name, an ID that differs only by an effort word, or missing evidence leaves a route `unknown`, and sign-in or status text never proves one. Dispatch the author only when the room is `open`.",
        version: 33,
      },
      {
        kind: "behavior",
        summary:
          "The final `remote-inventory build` proposes deleting a provider branch a merged proposal recorded at exactly its head when the head did not move during the run, the branch is unprotected and not the target, and no open proposal, live worktree, claim, upstream, or fork point uses it, or one a `--decisions` entry approves at its unchanged opening head, listed under `deletionProposals` with `heldBranches` beside it; nothing is deleted automatically, each proposal still goes through `loop guard`, an exact provider deletion, and `loop verify`, and a shallow clone proposes nothing. `loop finalize` reports `cleanupStatus: pending`, naming each branch, head, and proof under `remoteBranches.pending`, whenever it kept a provider branch a merged proposal or Git ancestry proves finished, lists branches still in use under `remoteBranches.held`, and treats evidence Git cannot settle as an error that keeps cleanup pending; pending never blocks delivery. Proposal pages may carry `openProposalTargets`, which older builders reject.",
        version: 33,
      },
      // <!-- lineage -->
      {
        kind: "behavior",
        summary:
          "`prune --agent-id <ID> --lineage-receipt <file>` and `worktree cleanup --lineage-receipt <file>` remove one clean checkout whose work shipped through changed replacement commits when the receipt maps every commit the reviewed target lacks to replacement commits in it, an independent reviewer checked the mapping, and the user approved within 24 hours afterwards, reported as `reviewed-replacement`. The checkout and its private Git directory are archived first under `<common Git directory>/simple-changes/archives/<archive ID>/` with a manifest, its head and every object it names are pinned under `refs/simple-changes/archives/<archive ID>/`, and `worktree restore-archive --archive <archive ID>` brings it back; `worktree archives` lists archives. Archives expire after policy `archiveRetention.days` (default 14) and are kept under `archiveRetention.maxTotalBytes` (default 2147483648), pruned automatically at the end of a successful `prune`, `worktree cleanup`, or closed `loop finalize` except when the target no longer holds the replacement commits, and `worktree prune-archives` prunes by hand. A policy that sets `archiveRetention` needs 0.33.0 or later.",
        version: 33,
      },
      {
        kind: "integration",
        summary:
          "Simple Changes discovers a repository's own changelog provider under any folder name in the repository's skill folders when that folder holds a valid `changelog-provider.json` marker and its folder, `SKILL.md`, and marker really live inside the repository, and ranks it ahead of globally installed providers, so a newer global install the repository never chose no longer drives a false Simple Changelogs update notice. A renamed folder without that marker, or in a global skill root, is ignored, and a discovery-only renamed provider never shadows one that can take the release handoff.",
        version: 33,
      },
    ],
    noticeBullets: [
      {
        priority: 190,
        summary:
          "If you hold a unit back with the new `loop hold-unit`, copies of Simple Changes older than 0.33.0 cannot read that run at all, so keep every copy that shares the repository on 0.33.0 or later before holding one.",
      },
      {
        priority: 185,
        summary:
          "Finishing a run now reports cleanup as pending when it kept a branch on your Git host that is already merged or contained in the target, and the final remote inventory proposes deleting merged branches nothing uses; nothing is deleted without the usual guarded steps.",
      },
      {
        priority: 185,
        summary:
          "Before starting an agent on work that needs an independent review, run `reviewer room` to check that a different reviewer will still be available afterwards, instead of finding out once the work is written.",
      },
      // <!-- lineage -->
      {
        priority: 180,
        summary:
          "A clean checkout whose work shipped as reworked commits can now be removed after review and your approval, and it is archived first: `worktree restore-archive` brings it back, and the archive is deleted on its own after 14 days or when archives pass 2 GiB, both settable under `archiveRetention`.",
      },
    ],
    version: 33,
  },
];

/**
 * The practical notice for one guidance version: its notice bullets, or its
 * change summaries when it has none; empty for a version with no definition.
 */
export const guidanceNotice = (version: number): string[] => {
  const update = GUIDANCE_UPDATES.find((entry) => entry.version === version);
  if (!update) {
    return [];
  }
  return update.noticeBullets && update.noticeBullets.length > 0
    ? update.noticeBullets.map((bullet) => bullet.summary)
    : update.changes.map((change) => change.summary);
};

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
  changelogCoordination: ChangelogCoordination,
  context: GuidanceUpdateContext = {}
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
  const requiredAnswers = pending.flatMap((update) =>
    (update.requiredAnswers ?? []).flatMap((answer) => {
      if (!("when" in answer)) {
        return [answer];
      }
      const question = context.questions?.[answer.id];
      return question && answerApplies(answer, context) ? [question] : [];
    })
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
