import { authorCoverage } from "./author-coverage.ts";
import {
  type AuthoringEffort,
  type AuthoringSidecar,
  canonicalModelId,
  EFFORT_LEVELS,
  higherEffort,
  isHarnessId,
  isModelName,
  MOST_CAPABLE,
  type RepositoryAuthoring,
} from "./authoring.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { locateRepository } from "./inventory.ts";
import {
  type Attestation,
  type CommitGaps,
  escalatedEffort,
  headCoverage,
  isProposalId,
  latestRecordedHead,
  type ReviewAttempt,
  type ReviewLedgerState,
  readReviewLedger,
  targetDistinctness,
} from "./review-ledger.ts";

// The reviewer room: a read-only preflight a controller runs before it
// dispatches an author. Given the authors the ledger already attests for the
// range and proposal, plus the author about to be dispatched, it reports
// which reviewer routes for the configured review model would still pass
// diverse review at the current escalation floor, and which ones the new
// author would rule out. It writes nothing: no ledger, lease, claim, or
// sidecar. It names no harness: candidates come only from the review role,
// harness detection, and routes the controller reports it ran. It never
// probes a harness, so availability is unknown unless the controller reports
// a real run of that model at that effort.

export interface RoomIdentity {
  harness: string;
  model: string;
}

/** A route the controller reports it really ran: that model at that effort. */
export interface VerifiedRoute extends RoomIdentity {
  effort: AuthoringEffort;
}

export interface RoomAuthor {
  agent: string | null;
  // The range commits whose effective authors include this identity; empty
  // for an author not yet dispatched.
  commits: string[];
  harness: string | null;
  instance: string | null;
  logicalId: string | null;
  // The canonical model ID the identity reports, or null for a display name,
  // an effort label, the planning sentinel, or a blank name.
  modelId: string | null;
  session: string | null;
  source: "attested" | "would-author";
}

export type RoomVerdict =
  | "distinct"
  | "same"
  | "unknown-author"
  | "unknown-model"
  | "unknown-target"
  | "effort-label-only"
  | "executor-unknown";

export interface RoomConflict extends RoomAuthor {
  verdict: Exclude<RoomVerdict, "distinct">;
}

export type RoomAvailability = "controller-verified" | "unknown";

export type RoomReason =
  | "authoring-repair"
  | "author-identity-missing"
  | "authors-not-recorded"
  | "coverage-incomplete"
  | "independence-unproven"
  | "ledger-cycle"
  | "ledger-malformed"
  | "model-differs-only-by-effort"
  | "most-capable-unresolved"
  | "no-delegation"
  | "reviewer-model-id-missing"
  | "reviewer-not-distinct"
  | "running-harness-unknown";

export interface RoomCandidate {
  availability: {
    effort: RoomAvailability;
    escalationEffort: RoomAvailability | null;
  };
  conflicts: RoomConflict[];
  effort: AuthoringEffort;
  eligibility: "eligible" | "ruled-out" | "unknown";
  escalationEffort: AuthoringEffort | null;
  // null only when the review role targets the running harness and nothing
  // identifies it.
  harness: string | null;
  model: string;
  modelId: string | null;
  reason: RoomReason | null;
  // configured: the review role's own target; detected: another harness
  // detected on this machine; verified: a harness only the controller's
  // reported run names. Only the configured route is the owner's choice.
  route: "configured" | "detected" | "verified";
  // Not ruled out by the attested authors alone, and ruled out once the
  // would-be authors are added.
  ruledOutByWouldAuthor: boolean;
}

export type RoomStatus = "open" | "alternative-only" | "closed" | "unknown";

export interface ReviewerRoom {
  adversarial: boolean;
  authors: RoomAuthor[];
  candidates: RoomCandidate[];
  ledger: {
    errors: string[];
    path: string;
    state: ReviewLedgerState["state"];
  };
  message: string;
  proposal: {
    attempts: number;
    proposalId: string;
    recordedHead: string | null;
  } | null;
  range: {
    base: string;
    commits: string[];
    gaps: Record<string, CommitGaps>;
    head: string;
    unattributed: string[];
  } | null;
  reason: RoomReason | null;
  required: {
    effort: AuthoringEffort;
    effortSource: "configured" | "escalation";
    // The effort a later round needs after escalating findings, when it is
    // higher than `effort`; null otherwise.
    escalationEffort: AuthoringEffort | null;
    harness: string | null;
    model: string;
    modelId: string | null;
  };
  status: RoomStatus;
}

export interface ReviewerRoomInput {
  authoring: RepositoryAuthoring;
  base?: string;
  head?: string;
  proposalId?: string;
  repositoryRoot: string;
  // The current request's sidecar object, the same one resolution used.
  request?: AuthoringSidecar | null;
  verifiedRoutes?: readonly VerifiedRoute[];
  wouldAuthors: readonly RoomIdentity[];
}

const EFFORT_SUFFIX = new RegExp(`[._-](?:${EFFORT_LEVELS.join("|")})$`, "u");

const splitRoute = (
  value: string,
  option: string
): { harness: string; rest: string } => {
  const slash = value.indexOf("/");
  const harness = slash === -1 ? "" : value.slice(0, slash).trim();
  const rest = slash === -1 ? "" : value.slice(slash + 1).trim();
  if (!(isHarnessId(harness) && rest)) {
    throw new SimpleChangesError(
      `${option} must be <harness id>/<model ID>; got ${JSON.stringify(value)}.`,
      EXIT_CODES.usage
    );
  }
  return { harness, rest };
};

/** `--would-author <harness id>/<model>`: the author about to be dispatched. */
export const parseWouldAuthor = (value: string): RoomIdentity => {
  const { harness, rest } = splitRoute(value, "--would-author");
  if (!isModelName(rest)) {
    throw new SimpleChangesError(
      "--would-author must name the model the author will run.",
      EXIT_CODES.usage
    );
  }
  return { harness, model: rest };
};

/**
 * `--verified-route <harness id>/<model ID>@<effort>`: a route the controller
 * really ran, that model at that effort. A display name is not an ID, so it
 * never proves a route.
 */
export const parseVerifiedRoute = (value: string): VerifiedRoute => {
  const at = value.lastIndexOf("@");
  const effort = at === -1 ? "" : value.slice(at + 1).trim();
  if (!(EFFORT_LEVELS as readonly string[]).includes(effort)) {
    throw new SimpleChangesError(
      `--verified-route must end in @<effort>, one of ${EFFORT_LEVELS.join(", ")}; got ${JSON.stringify(value)}.`,
      EXIT_CODES.usage
    );
  }
  const { harness, rest } = splitRoute(value.slice(0, at), "--verified-route");
  if (canonicalModelId(rest) === null) {
    throw new SimpleChangesError(
      `--verified-route must name a model ID, not a display name or an effort label; got ${JSON.stringify(rest)}.`,
      EXIT_CODES.usage
    );
  }
  return { effort: effort as AuthoringEffort, harness, model: rest };
};

const identityKey = (author: Attestation): string =>
  JSON.stringify([
    author.agent,
    author.harness,
    author.instance,
    author.session,
    author.logicalId,
  ]);

const wouldAuthor = (identity: RoomIdentity): RoomAuthor => ({
  agent: identity.model,
  commits: [],
  harness: identity.harness,
  instance: null,
  logicalId: null,
  modelId: canonicalModelId(identity.model),
  session: null,
  source: "would-author",
});

/**
 * Two IDs in one harness that differ only by a trailing effort word, such as
 * `model-5-5` and `model-5-5-xhigh`, are not shown to be different models:
 * an effort label is never diversity.
 */
const differsOnlyByEffort = (left: string, right: string): boolean =>
  left !== right &&
  left.replace(EFFORT_SUFFIX, "") === right.replace(EFFORT_SUFFIX, "");

const diversityVerdict = (
  target: { harness: string; model: string },
  author: RoomAuthor
): RoomVerdict => {
  const verdict = targetDistinctness(
    target,
    { agent: author.agent, harness: author.harness },
    false
  );
  if (verdict !== "distinct" || target.harness !== author.harness) {
    return verdict;
  }
  const targetId = canonicalModelId(target.model);
  return targetId !== null &&
    author.modelId !== null &&
    differsOnlyByEffort(targetId, author.modelId)
    ? "effort-label-only"
    : verdict;
};

/**
 * The gate rejects every reviewer as `independence-unproven` beside an
 * attested author that recorded neither an instance nor a session, under
 * either adversarial setting. A would-be author attests from its own
 * session, so it is not judged here.
 */
const executorUnknown = (author: RoomAuthor): boolean =>
  author.source === "attested" &&
  author.instance === null &&
  author.session === null;

const roomVerdict = (
  target: { harness: string; model: string },
  author: RoomAuthor,
  adversarial: boolean
): RoomVerdict => {
  const verdict = adversarial ? diversityVerdict(target, author) : "distinct";
  return verdict === "distinct" && executorUnknown(author)
    ? "executor-unknown"
    : verdict;
};

// The precedence pre-dispatch resolution uses: a proven match rules the
// route out before any missing evidence leaves it unknown.
const VERDICT_REASONS: [Exclude<RoomVerdict, "distinct">, RoomReason][] = [
  ["same", "reviewer-not-distinct"],
  ["executor-unknown", "independence-unproven"],
  ["unknown-author", "author-identity-missing"],
  ["unknown-target", "reviewer-model-id-missing"],
  ["unknown-model", "most-capable-unresolved"],
  ["effort-label-only", "model-differs-only-by-effort"],
];

const evaluate = (
  target: { harness: string; model: string },
  authors: readonly RoomAuthor[],
  adversarial: boolean
): Pick<RoomCandidate, "conflicts" | "eligibility" | "reason"> => {
  const conflicts: RoomConflict[] = [];
  for (const author of authors) {
    const verdict = roomVerdict(target, author, adversarial);
    if (verdict !== "distinct") {
      conflicts.push({ ...author, verdict });
    }
  }
  for (const [verdict, reason] of VERDICT_REASONS) {
    if (conflicts.some((conflict) => conflict.verdict === verdict)) {
      return {
        conflicts,
        eligibility: verdict === "same" ? "ruled-out" : "unknown",
        reason,
      };
    }
  }
  return { conflicts, eligibility: "eligible", reason: null };
};

// A harness entry of null, at the highest layer that defines the id, means
// the owner does not delegate to that harness.
const refusesDelegation = (
  authoring: RepositoryAuthoring,
  request: AuthoringSidecar | null,
  harness: string
): boolean => {
  const layers = [
    request,
    authoring.authoringFiles.repository.value ?? null,
    authoring.authoringFiles.personal.value ?? null,
  ].filter((value): value is AuthoringSidecar => value !== null);
  const defining = layers.find((candidate) =>
    Object.hasOwn(candidate.harnesses, harness)
  );
  return defining !== undefined && defining.harnesses[harness] === null;
};

const availabilityAt = (
  routes: readonly VerifiedRoute[],
  harness: string | null,
  modelId: string | null,
  effort: AuthoringEffort
): RoomAvailability =>
  harness !== null &&
  modelId !== null &&
  routes.some(
    (route) =>
      route.harness === harness &&
      canonicalModelId(route.model) === modelId &&
      route.effort === effort
  )
    ? "controller-verified"
    : "unknown";

const describeAuthor = (author: RoomAuthor): string => {
  const who = `${author.harness ?? "unknown harness"}/${author.agent ?? "unknown model"}`;
  if (author.source === "would-author") {
    return `${who} (would-be author)`;
  }
  const id = author.logicalId ? ` ${author.logicalId}` : "";
  const commits =
    author.commits.length > 0 ? ` on ${author.commits.join(", ")}` : "";
  return `${who} (attested${id}${commits})`;
};

const REASON_TEXT: Record<RoomReason, string> = {
  "author-identity-missing":
    "an author lacks the harness or model ID diversity needs",
  "authoring-repair": "an authoring sidecar is malformed and must be repaired",
  "authors-not-recorded":
    "the proposal has no recorded head and no range was given, so its authors are unknown",
  "coverage-incomplete":
    "some commits have no attested author, so not every author is known",
  "independence-unproven":
    "an attested author recorded neither an instance nor a session, so no reviewer can be shown to be a different executor",
  "ledger-cycle": "the review ledger holds a replay cycle",
  "ledger-malformed":
    "the review ledger is malformed, so its authors are unknown",
  "model-differs-only-by-effort":
    "a model ID differs from the reviewer's only by an effort label, which is not a different model",
  "most-capable-unresolved":
    "the review model is the most-capable sentinel, so no model ID can be compared",
  "no-delegation": "the owner does not delegate to that harness",
  "reviewer-model-id-missing": "the review model is not a model ID",
  "reviewer-not-distinct":
    "an author runs the same model ID in the reviewer's harness",
  "running-harness-unknown": "the running harness cannot be identified",
};

const routeLabel = (candidate: RoomCandidate): string =>
  `${candidate.model} in ${candidate.harness ?? "an unidentified harness"} at ${candidate.effort}`;

const roomMessage = (
  status: RoomStatus,
  reason: RoomReason | null,
  candidates: readonly RoomCandidate[],
  adversarial: boolean
): string => {
  const [configured] = candidates;
  const alternatives = candidates
    .filter(
      (candidate) =>
        candidate.route !== "configured" && candidate.eligibility === "eligible"
    )
    .map((candidate) => candidate.harness);
  switch (status) {
    case "closed":
      return candidates.some((candidate) => candidate.ruledOutByWouldAuthor)
        ? "This author would leave no eligible reviewer: every reviewer route for the required model and effort would be ruled out. Dispatch a different author model or harness, or ask the owner."
        : "No eligible reviewer remains even without this author: the attested authors or the owner's settings rule out every reviewer route. Ask the owner how to proceed.";
    case "open":
      return adversarial
        ? `The configured reviewer, ${configured ? routeLabel(configured) : "the review role"}, stays eligible.`
        : "The review role is not adversarial, so diversity is not required; executor independence is still checked after the review returns.";
    case "alternative-only":
      return `The configured reviewer is ${configured?.eligibility === "ruled-out" ? "ruled out" : "not shown eligible"}${configured?.reason ? ` (${REASON_TEXT[configured.reason]})` : ""}. The same model in ${alternatives.join(", ")} would stay eligible, but only if the owner chooses that route and a real run of the model at that effort proves it.`;
    default:
      return `Eligibility is unknown: ${reason ? REASON_TEXT[reason] : "evidence is missing"}. Treat the room as closed until the evidence exists.`;
  }
};

interface RoomEvidence {
  attempts: ReviewAttempt[];
  authors: RoomAuthor[];
  covered: boolean;
  proposal: ReviewerRoom["proposal"];
  range: ReviewerRoom["range"];
}

const rangeEvidence = (input: ReviewerRoomInput): ReviewerRoom["range"] => {
  if (input.base === undefined || input.head === undefined) {
    return null;
  }
  const coverage = authorCoverage(input.repositoryRoot, input.base, input.head);
  return {
    base: coverage.base,
    commits: coverage.commits,
    gaps: coverage.gaps,
    head: coverage.head,
    unattributed: coverage.unattributed,
  };
};

const proposalEvidence = (
  state: ReviewLedgerState,
  proposalId: string | undefined
): {
  attempts: ReviewAttempt[];
  commits: string[];
  proposal: ReviewerRoom["proposal"];
} => {
  if (proposalId === undefined) {
    return { attempts: [], commits: [], proposal: null };
  }
  const record =
    state.reason === null && Object.hasOwn(state.ledger.proposals, proposalId)
      ? state.ledger.proposals[proposalId]
      : undefined;
  const attempts = record?.attempts ?? [];
  const recordedHead = record ? latestRecordedHead(record) : null;
  return {
    attempts,
    commits:
      record && recordedHead !== null
        ? (record.heads[recordedHead]?.commits ?? [])
        : [],
    proposal: { attempts: attempts.length, proposalId, recordedHead },
  };
};

const ledgerEvidence = (
  state: ReviewLedgerState,
  input: ReviewerRoomInput
): RoomEvidence => {
  const range = rangeEvidence(input);
  const {
    attempts,
    commits: headCommits,
    proposal,
  } = proposalEvidence(state, input.proposalId);
  // Every known author counts: the range's and the proposal's recorded head's.
  const commits = [...new Set([...(range?.commits ?? []), ...headCommits])];
  if (state.reason !== null) {
    return { attempts, authors: [], covered: false, proposal, range };
  }
  const coverage = headCoverage(state.ledger, commits);
  const authors = new Map<string, RoomAuthor>();
  for (const commit of commits) {
    const list = Object.hasOwn(coverage.authors, commit)
      ? (coverage.authors[commit] ?? [])
      : [];
    for (const author of list) {
      const key = identityKey(author);
      const known = authors.get(key);
      if (known) {
        known.commits.push(commit);
        continue;
      }
      authors.set(key, {
        agent: author.agent,
        commits: [commit],
        harness: author.harness,
        instance: author.instance,
        logicalId: author.logicalId,
        modelId: canonicalModelId(author.agent),
        session: author.session,
        source: "attested",
      });
    }
  }
  return {
    attempts,
    authors: [...authors.values()],
    covered: coverage.fullyCovered,
    proposal,
    range,
  };
};

const validateInput = (input: ReviewerRoomInput): void => {
  if (input.wouldAuthors.length === 0) {
    throw new SimpleChangesError(
      "reviewer room requires --would-author <harness id>/<model ID>.",
      EXIT_CODES.usage
    );
  }
  if ((input.base === undefined) !== (input.head === undefined)) {
    throw new SimpleChangesError(
      "--base and --head must be given together.",
      EXIT_CODES.usage
    );
  }
  if (input.proposalId !== undefined && !isProposalId(input.proposalId)) {
    throw new SimpleChangesError(
      "--proposal must be the provider's stable proposal id (letters, digits, and . _ : / # ! @ + -, at most 200 characters).",
      EXIT_CODES.usage
    );
  }
};

const checkRoutes = (
  routes: readonly VerifiedRoute[],
  reviewModel: string
): void => {
  const modelId = canonicalModelId(reviewModel);
  for (const route of routes) {
    if (modelId === null || canonicalModelId(route.model) !== modelId) {
      throw new SimpleChangesError(
        modelId === null
          ? `The review model ${JSON.stringify(reviewModel)} is not a model ID, so no --verified-route can match it.`
          : `--verified-route names ${route.model}; the room checks only the review model ${modelId}.`,
        EXIT_CODES.usage
      );
    }
  }
};

interface RoomContext {
  attested: readonly RoomAuthor[];
  authoring: RepositoryAuthoring;
  authors: readonly RoomAuthor[];
  effort: AuthoringEffort;
  escalationEffort: AuthoringEffort | null;
  modelId: string | null;
  request: AuthoringSidecar | null;
  routes: readonly VerifiedRoute[];
}

const candidateRoute = (
  context: RoomContext,
  harness: string | null,
  route: RoomCandidate["route"]
): RoomCandidate => {
  const { review } = context.authoring.effective;
  const base = {
    availability: {
      effort: availabilityAt(
        context.routes,
        harness,
        context.modelId,
        context.effort
      ),
      escalationEffort:
        context.escalationEffort === null
          ? null
          : availabilityAt(
              context.routes,
              harness,
              context.modelId,
              context.escalationEffort
            ),
    },
    effort: context.effort,
    escalationEffort: context.escalationEffort,
    harness,
    model: review.model,
    modelId: context.modelId,
    route,
  };
  const settled = (
    eligibility: RoomCandidate["eligibility"],
    reason: RoomReason | null
  ): RoomCandidate => ({
    ...base,
    conflicts: [],
    eligibility,
    reason,
    ruledOutByWouldAuthor: false,
  });
  if (harness === null) {
    return settled("unknown", "running-harness-unknown");
  }
  const noDelegation =
    route === "configured"
      ? review.status === "no-delegation"
      : refusesDelegation(context.authoring, context.request, harness);
  if (noDelegation) {
    return settled("ruled-out", "no-delegation");
  }
  // Diversity compares model IDs only: a reviewer model that is not one
  // (a display name, an effort label, the sentinel) proves no route.
  if (review.adversarial && context.modelId === null) {
    return settled(
      "unknown",
      review.model.trim() === MOST_CAPABLE
        ? "most-capable-unresolved"
        : "reviewer-model-id-missing"
    );
  }
  const target = { harness, model: review.model };
  const withAll = evaluate(target, context.authors, review.adversarial);
  const attestedOnly = evaluate(target, context.attested, review.adversarial);
  return {
    ...base,
    ...withAll,
    ruledOutByWouldAuthor:
      withAll.eligibility === "ruled-out" &&
      attestedOnly.eligibility !== "ruled-out",
  };
};

// The one room-wide reason evidence is missing, or null. It is decided once
// and applied to every route below, so no route reads eligible while the
// room as a whole is not provably open.
const roomWideReason = (
  input: ReviewerRoomInput,
  state: ReviewLedgerState,
  evidence: Pick<RoomEvidence, "covered" | "proposal">
): RoomReason | null => {
  if (input.authoring.repairRequired) {
    return "authoring-repair";
  }
  if (state.reason !== null) {
    return state.reason;
  }
  // A named proposal the ledger has no head for, with no range beside it,
  // has authors nobody can list yet.
  if (
    input.proposalId !== undefined &&
    input.base === undefined &&
    !evidence.proposal?.recordedHead
  ) {
    return "authors-not-recorded";
  }
  return evidence.covered ? null : "coverage-incomplete";
};

// A proven conflict stays ruled out, since more evidence can only add
// authors; any other route the room-wide reason leaves unknown. A sidecar
// that needs repair leaves the settings themselves unknown, so every route
// is unknown then.
const applyRoomWide = (
  candidates: readonly RoomCandidate[],
  reason: RoomReason | null
): RoomCandidate[] =>
  candidates.map((candidate) =>
    reason !== null &&
    (candidate.eligibility === "eligible" || reason === "authoring-repair")
      ? {
          ...candidate,
          eligibility: "unknown",
          reason,
          ruledOutByWouldAuthor: false,
        }
      : candidate
  );

const roomStatus = (
  candidates: readonly RoomCandidate[],
  roomWide: RoomReason | null
): { reason: RoomReason | null; status: RoomStatus } => {
  const [configured] = candidates as [RoomCandidate];
  // More authors only rule out more routes, so a room the known authors
  // already close stays closed whatever evidence is still missing.
  if (candidates.every((item) => item.eligibility === "ruled-out")) {
    return { reason: configured.reason, status: "closed" };
  }
  if (roomWide !== null) {
    return { reason: roomWide, status: "unknown" };
  }
  if (configured.eligibility === "eligible") {
    return { reason: null, status: "open" };
  }
  if (
    candidates.some(
      (item) => item.route !== "configured" && item.eligibility === "eligible"
    )
  ) {
    return { reason: configured.reason, status: "alternative-only" };
  }
  const unknown =
    configured.eligibility === "unknown"
      ? configured
      : candidates.find((item) => item.eligibility === "unknown");
  return { reason: unknown?.reason ?? null, status: "unknown" };
};

/**
 * `reviewer room`: which reviewer routes stay eligible if the would-be
 * authors are dispatched. Read-only. A route is ruled out only by a proven
 * match; missing evidence leaves it unknown, and unknown never reads as open.
 */
export const reviewerRoom = (input: ReviewerRoomInput): ReviewerRoom => {
  validateInput(input);
  const { review } = input.authoring.effective;
  const routes = input.verifiedRoutes ?? [];
  checkRoutes(routes, review.model);
  const { commonGitDirectory } = locateRepository(
    input.repositoryRoot
  ).repository;
  const state = readReviewLedger(commonGitDirectory);
  const evidence = ledgerEvidence(state, input);
  const effort = escalatedEffort(
    review.effort,
    review.escalateOnFindings,
    evidence.attempts,
    review.reviewLoop.escalateOn
  );
  const escalation = review.escalateOnFindings
    ? higherEffort(review.effort, review.escalateOnFindings)
    : null;
  const configuredHarness =
    review.status === "unresolved" ? null : review.harness;
  const context: RoomContext = {
    attested: evidence.authors,
    authoring: input.authoring,
    authors: [...evidence.authors, ...input.wouldAuthors.map(wouldAuthor)],
    effort: effort.effort,
    escalationEffort:
      escalation !== null && escalation !== effort.effort ? escalation : null,
    modelId: canonicalModelId(review.model),
    request: input.request ?? null,
    routes,
  };
  const routed = [candidateRoute(context, configuredHarness, "configured")];
  const seen = new Set<string>(configuredHarness ? [configuredHarness] : []);
  const others: [string, RoomCandidate["route"]][] = [
    ...input.authoring.detectedHarnesses.map(
      (detected) => [detected.id, "detected"] as [string, "detected"]
    ),
    ...routes.map(
      (route) => [route.harness, "verified"] as [string, "verified"]
    ),
  ];
  for (const [harness, route] of others) {
    if (!seen.has(harness)) {
      seen.add(harness);
      routed.push(candidateRoute(context, harness, route));
    }
  }
  const roomWide = roomWideReason(input, state, evidence);
  const candidates = applyRoomWide(routed, roomWide);
  const { reason, status } = roomStatus(candidates, roomWide);
  return {
    adversarial: review.adversarial,
    authors: [...context.authors],
    candidates,
    ledger: { errors: state.errors, path: state.path, state: state.state },
    message: roomMessage(status, reason, candidates, review.adversarial),
    proposal: evidence.proposal,
    range: evidence.range,
    reason,
    required: {
      effort: effort.effort,
      effortSource: effort.effortSource,
      escalationEffort: context.escalationEffort,
      harness: configuredHarness,
      model: review.model,
      modelId: context.modelId,
    },
    status,
  };
};

const describeAvailability = (candidate: RoomCandidate): string => {
  const parts = [`at ${candidate.effort} ${candidate.availability.effort}`];
  if (candidate.escalationEffort && candidate.availability.escalationEffort) {
    parts.push(
      `at ${candidate.escalationEffort} ${candidate.availability.escalationEffort}`
    );
  }
  return `availability ${parts.join(", ")}`;
};

const describeCandidate = (candidate: RoomCandidate): string => {
  const verdict =
    candidate.eligibility === "eligible"
      ? "eligible"
      : `${candidate.eligibility === "ruled-out" ? "ruled out" : "unknown"} (${candidate.reason})`;
  const conflicts =
    candidate.conflicts.length > 0
      ? `; conflicts: ${candidate.conflicts.map((conflict) => `${describeAuthor(conflict)} ${conflict.verdict}`).join("; ")}`
      : "";
  const ruledOut = candidate.ruledOutByWouldAuthor
    ? "; ruled out by the would-be author"
    : "";
  return `- ${candidate.route} ${candidate.harness ?? "unidentified harness"}: ${verdict}${conflicts}${ruledOut}; ${describeAvailability(candidate)}`;
};

/** The room as text, one line per author and per route. */
export const renderReviewerRoom = (room: ReviewerRoom): string => {
  const { required } = room;
  const escalated =
    required.effortSource === "escalation" ? " (escalated after findings)" : "";
  const later = required.escalationEffort
    ? `, ${required.escalationEffort} after escalating findings`
    : "";
  const lines = [
    `Reviewer room: ${room.status}${room.reason ? ` (${room.reason})` : ""}`,
    room.message,
    `Required: ${required.model} at ${required.effort}${escalated}${later}${room.adversarial ? ", different author model or harness required" : ""}`,
    "Authors:",
    ...room.authors.map((author) => `- ${describeAuthor(author)}`),
    "Reviewer routes:",
    ...room.candidates.map(describeCandidate),
    "A route counts as available only after a real run of that model at that effort; status or credential text is not evidence. Nothing was written.",
  ];
  return `${lines.join("\n")}\n`;
};
