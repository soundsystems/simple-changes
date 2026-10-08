import {
  type AuthoringEffort,
  type AuthoringRoleEntry,
  type AuthoringSetupStyle,
  type AuthoringSidecar,
  type DetectedHarness,
  EFFORT_LEVELS,
  type HarnessDefinition,
  isModelName,
  MOST_CAPABLE,
  RUNNING_HARNESS,
  sameModelName,
} from "./authoring.ts";

// The onboarding questions for authoring and review preferences (design
// section 5.1). Pure planning functions decide which questions apply and with
// which choices; `collectAuthoringAnswers` runs them through a prompter and
// returns the sidecar to save. Display names come from agents/harnesses.json
// or detection, so nothing here names a harness.

export interface AuthoringChoice {
  description: string;
  label: string;
  recommended: boolean;
  value: string;
}

export interface AuthoringPrompter {
  choose: (
    question: string,
    choices: readonly { description: string; label: string; value: string }[],
    defaultValue: string
  ) => Promise<string>;
  input?: (question: string) => Promise<string>;
  present?: (message: string) => void;
}

export interface AuthoringOnboardingContext {
  definitions: HarnessDefinition[];
  detected: DetectedHarness[];
  // The harness list a Simple Changelogs sidecar already records, if any.
  prefill: { harnesses: string[]; path: string } | null;
  runningHarness: string | null;
  setupStyle: AuthoringSetupStyle;
}

export const AUTHORING_QUESTIONS = {
  agents: "Which coding agents do you use? Choose one:",
  editAgents:
    "Which agents should I record? List their ids or names, separated by commas.",
  effort: (agent: string) =>
    `Which effort should that model use in ${agent}? Choose one:`,
  escalation:
    "After a review finds problems, how should later reviews of that change run? Choose one:",
  model: (agent: string, purpose: string) =>
    `In ${agent}, which model should ${purpose}? Choose one:`,
  modelName: (agent: string) => `Which model in ${agent}? Name it.`,
  prefill: (names: string) =>
    `Simple Changelogs already lists your agents: ${names}. Use the same list here? Choose one:`,
  reviewAgent: "Which agent should review? Choose one:",
  reviewer: "Who should perform independent reviews? Choose one:",
  reviewModel: (agent: string) => `Which model in ${agent} should review?`,
} as const;

export const AUTHORING_PREFERENCE_NOTE =
  "This is a preference, not a permission. The agent still asks before launching another tool for the first time, and every proposal and review is signed by the model that actually wrote it.";

export const PROPOSALS_PURPOSE =
  "write proposal descriptions and merge messages";
export const REVIEW_PURPOSE = "review";

/** The display name for a harness id: the data file's name, else the id. */
export const harnessLabel = (
  id: string,
  definitions: readonly HarnessDefinition[]
): string => definitions.find((definition) => definition.id === id)?.name ?? id;

/** Known ids in data-file order, then unknown ids alphabetically. */
export const orderHarnessIds = (
  ids: readonly string[],
  definitions: readonly HarnessDefinition[]
): string[] => {
  const unique = [...new Set(ids)];
  const known = definitions
    .map((definition) => definition.id)
    .filter((id) => unique.includes(id));
  const unknown = unique
    .filter((id) => !known.includes(id))
    .sort((left, right) => left.localeCompare(right));
  return [...known, ...unknown];
};

const namesOf = (
  ids: readonly string[],
  definitions: readonly HarnessDefinition[]
): string => ids.map((id) => harnessLabel(id, definitions)).join(", ");

/**
 * Question A. Option 3 is omitted when nothing is detected beyond the running
 * harness (option 1 then names only it) and when the running harness is
 * unknown; with nothing detected, only "Edit the list" is offered.
 */
export const agentListChoices = (
  context: Pick<
    AuthoringOnboardingContext,
    "definitions" | "detected" | "runningHarness"
  >
): AuthoringChoice[] => {
  const detectedIds = context.detected.map((harness) => harness.id);
  const choices: AuthoringChoice[] = [];
  if (detectedIds.length > 0) {
    choices.push({
      description: "Record these; the next question asks about each.",
      label: `The ones I found: ${namesOf(detectedIds, context.definitions)}`,
      recommended: true,
      value: "found",
    });
  }
  choices.push({
    description: "Add or remove agents by name, for tools I did not detect.",
    label: "Edit the list",
    recommended: detectedIds.length === 0,
    value: "edit",
  });
  const beyondRunning = detectedIds.some((id) => id !== context.runningHarness);
  if (context.runningHarness && beyondRunning) {
    choices.push({
      description: "Record just this one.",
      label: "Only the agent running now",
      recommended: false,
      value: "running",
    });
  }
  return choices;
};

/** Question B for one harness and one purpose. */
export const modelChoices = (agent: string): AuthoringChoice[] => [
  {
    description: `Records the most capable model ${agent} reports, at xhigh effort.`,
    label: "The most capable model available, at xhigh effort",
    recommended: true,
    value: "most-capable",
  },
  {
    description: "Name it, then choose an effort (xhigh by default).",
    label: "A specific model",
    recommended: false,
    value: "specific",
  },
  {
    description: `Records nothing to delegate to in ${agent}; whatever model is running writes, with no delegation.`,
    label: "Do not guide this",
    recommended: false,
    value: "none",
  },
];

const EFFORT_DESCRIPTIONS: Record<AuthoringEffort, string> = {
  high: "Careful work at moderate cost.",
  low: "The fastest and cheapest setting.",
  max: "The slowest and most expensive setting, for when every change must get the longest deliberation.",
  medium: "A balance of speed and care.",
  xhigh: "The most careful setting short of max.",
};

/** Efforts with `xhigh` recommended; `max` is offered with its cost, never pre-selected. */
export const effortChoices = (): AuthoringChoice[] =>
  EFFORT_LEVELS.map((effort) => ({
    description: EFFORT_DESCRIPTIONS[effort],
    label: effort,
    recommended: effort === "xhigh",
    value: effort,
  }));

const concreteModels = (
  sidecar: Pick<AuthoringSidecar, "harnesses" | "roles">
) =>
  new Set(
    [
      ...Object.values(sidecar.harnesses).map((entry) => entry?.model),
      ...Object.values(sidecar.roles).map((entry) => entry?.model),
    ].filter(
      (model): model is string =>
        typeof model === "string" && model !== MOST_CAPABLE
    )
  );

/**
 * The 5.1.3 trigger. Two or more detected harnesses ask in every setup style,
 * run-only included, whatever was selected in Question A. Otherwise the
 * questions are asked in Customize and the walkthrough, or when a second
 * model name was recorded across roles; recommended setup records nothing.
 */
export const asksReviewQuestions = (input: {
  answers: Pick<AuthoringSidecar, "harnesses" | "roles">;
  detectedCount: number;
  setupStyle: AuthoringSetupStyle;
}): boolean =>
  input.detectedCount >= 2 ||
  input.setupStyle === "customize" ||
  input.setupStyle === "walkthrough" ||
  concreteModels(input.answers).size >= 2;

/**
 * Question R1. Option 1 needs two or more recorded harnesses; option 2 needs
 * an identified running harness (its id binds the model). Options 1 and 2
 * record an adversarial review; option 3 does not.
 */
export const reviewerChoices = (input: {
  recordedHarnesses: readonly string[];
  runningHarness: string | null;
}): AuthoringChoice[] => {
  const multiple = new Set(input.recordedHarnesses).size >= 2;
  const choices: AuthoringChoice[] = [];
  if (multiple) {
    choices.push({
      description:
        "Reviews come from an agent other than the one that wrote the change.",
      label:
        "A different agent (Recommended when more than one agent is recorded)",
      recommended: true,
      value: "different-agent",
    });
  }
  if (input.runningHarness) {
    choices.push({
      description:
        "Name the model; the author's model is never its own reviewer. This covers one model shipping and another reviewing inside a single agent.",
      label: "A different model in the same agent (Recommended otherwise)",
      recommended: !multiple,
      value: "different-model",
    });
  }
  choices.push({
    description:
      "A separate session of the same model counts, as it does today.",
    label: "Any independent reviewer",
    recommended: choices.length === 0,
    value: "any",
  });
  return choices;
};

/**
 * Question R2 candidates: every recorded harness except the author's (the
 * proposals role's target; with an unknown running harness nothing is
 * excluded), known ids in data-file order, then unknown ids alphabetically.
 * The first is recommended; a single candidate skips the question.
 */
export const reviewAgentCandidates = (input: {
  authorHarness: string | null;
  definitions: readonly HarnessDefinition[];
  recordedHarnesses: readonly string[];
}): AuthoringChoice[] =>
  orderHarnessIds(
    input.recordedHarnesses.filter((id) => id !== input.authorHarness),
    input.definitions
  ).map((id, index) => {
    const label = harnessLabel(id, input.definitions);
    return {
      description: `Reviews run in ${label} with the model recorded for it.`,
      label,
      recommended: index === 0,
      value: id,
    };
  });

/**
 * Question R3': the named review model must differ from the model recorded
 * for the running harness (absent means the most capable model). Returns the
 * reason to ask again, or null when the name is acceptable.
 */
export const reviewModelProblem = (
  name: string,
  recorded: AuthoringSidecar["harnesses"][string] | undefined
): string | null => {
  if (!isModelName(name)) {
    return "Name a model of 1 to 120 characters without control characters.";
  }
  const authorModel = recorded?.model ?? MOST_CAPABLE;
  // The gate's own comparison: case, separators, and a shared suffix count as
  // the same model, so onboarding never saves a reviewer the gate blocks.
  return sameModelName(name, authorModel)
    ? "That is the model recorded for this agent, so it would review its own work; name a different model."
    : null;
};

/** Question R4: an effort floor after findings; `max` is never offered. */
export const escalationChoices = (): AuthoringChoice[] => [
  {
    description:
      "A change that already needed fixes gets at least the most careful review the agent offers short of max.",
    label: "At xhigh effort",
    recommended: true,
    value: "xhigh",
  },
  {
    description: "No escalation.",
    label: "Same effort as before",
    recommended: false,
    value: "same",
  },
];

/** The recommended answer: every listed harness at most-capable, xhigh. */
export const recommendedAuthoringAnswer = (
  harnesses: readonly string[]
): AuthoringSidecar => ({
  harnesses: Object.fromEntries(
    harnesses.map((id) => [id, { effort: "xhigh", model: MOST_CAPABLE }])
  ),
  roles: { proposals: { harness: RUNNING_HARNESS } },
  schemaVersion: 1,
});

const labelled = (choice: AuthoringChoice) => ({
  description: choice.description,
  label:
    choice.recommended && !choice.label.includes("(Recommended")
      ? `${choice.label} (Recommended)`
      : choice.label,
  value: choice.value,
});

const ask = async (
  prompter: AuthoringPrompter,
  question: string,
  choices: AuthoringChoice[]
): Promise<string> => {
  const fallback =
    choices.find((choice) => choice.recommended)?.value ??
    choices[0]?.value ??
    "";
  const answer = await prompter.choose(
    question,
    choices.map(labelled),
    fallback
  );
  return choices.some((choice) => choice.value === answer) ? answer : fallback;
};

const askName = async (
  prompter: AuthoringPrompter,
  question: string
): Promise<string | null> => {
  if (!prompter.input) {
    return null;
  }
  const name = (await prompter.input(question)).trim();
  return name.length > 0 ? name : null;
};

const parseAgentList = (
  text: string,
  definitions: readonly HarnessDefinition[]
): string[] =>
  text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(
      (item) =>
        definitions.find(
          (definition) =>
            definition.id === item.toLowerCase() ||
            definition.name.toLowerCase() === item.toLowerCase()
        )?.id ?? item.toLowerCase()
    );

const selectAgents = async (
  context: AuthoringOnboardingContext,
  prompter: AuthoringPrompter
): Promise<string[]> => {
  const detectedIds = context.detected.map((harness) => harness.id);
  const edit = async () => {
    const answer = await askName(prompter, AUTHORING_QUESTIONS.editAgents);
    return answer ? parseAgentList(answer, context.definitions) : detectedIds;
  };
  if (context.prefill) {
    const names = namesOf(context.prefill.harnesses, context.definitions);
    const reuse = await ask(prompter, AUTHORING_QUESTIONS.prefill(names), [
      {
        description:
          "Reuse the list; the next questions ask only about proposals and reviews.",
        label: "Yes",
        recommended: true,
        value: "yes",
      },
      {
        description: "Add or remove agents.",
        label: "Edit the list",
        recommended: false,
        value: "edit",
      },
    ]);
    return reuse === "yes" ? [...context.prefill.harnesses] : edit();
  }
  const choice = await ask(
    prompter,
    AUTHORING_QUESTIONS.agents,
    agentListChoices(context)
  );
  if (choice === "running" && context.runningHarness) {
    return [context.runningHarness];
  }
  return choice === "found" ? detectedIds : edit();
};

const askModel = async (
  prompter: AuthoringPrompter,
  agent: string,
  purpose: string
): Promise<AuthoringSidecar["harnesses"][string]> => {
  const choice = await ask(
    prompter,
    AUTHORING_QUESTIONS.model(agent, purpose),
    modelChoices(agent)
  );
  if (choice === "none") {
    return null;
  }
  const name =
    choice === "specific"
      ? await askName(prompter, AUTHORING_QUESTIONS.modelName(agent))
      : null;
  if (!(name && isModelName(name))) {
    return { effort: "xhigh", model: MOST_CAPABLE };
  }
  const effort = (await ask(
    prompter,
    AUTHORING_QUESTIONS.effort(agent),
    effortChoices()
  )) as AuthoringEffort;
  return { effort, model: name };
};

// Prompts run one after another; each answer can shape the next question.
const sequentially = <T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>
): Promise<R[]> =>
  items.reduce<Promise<R[]>>(
    async (previous, item) => [...(await previous), await run(item)],
    Promise.resolve([])
  );

const askDifferentAgent = async (
  context: AuthoringOnboardingContext,
  prompter: AuthoringPrompter,
  answer: AuthoringSidecar
): Promise<AuthoringRoleEntry> => {
  const candidates = reviewAgentCandidates({
    authorHarness: context.runningHarness,
    definitions: context.definitions,
    recordedHarnesses: Object.keys(answer.harnesses),
  });
  const target =
    candidates.length === 1
      ? (candidates[0]?.value ?? RUNNING_HARNESS)
      : await ask(prompter, AUTHORING_QUESTIONS.reviewAgent, candidates);
  if (!Object.hasOwn(answer.harnesses, target)) {
    answer.harnesses[target] = await askModel(
      prompter,
      harnessLabel(target, context.definitions),
      REVIEW_PURPOSE
    );
  }
  return { adversarial: true, harness: target };
};

// Asks for the review model until it differs from the author's (three tries).
const askReviewModelName = async (
  prompter: AuthoringPrompter,
  agent: string,
  recorded: AuthoringSidecar["harnesses"][string] | undefined,
  attemptsLeft: number
): Promise<string | null> => {
  if (attemptsLeft === 0) {
    return null;
  }
  const name = await askName(prompter, AUTHORING_QUESTIONS.reviewModel(agent));
  const problem =
    name === null
      ? "A model name is required."
      : reviewModelProblem(name, recorded);
  if (!problem) {
    return name;
  }
  prompter.present?.(problem);
  return askReviewModelName(prompter, agent, recorded, attemptsLeft - 1);
};

const askDifferentModel = async (
  context: AuthoringOnboardingContext,
  prompter: AuthoringPrompter,
  answer: AuthoringSidecar
): Promise<AuthoringRoleEntry | null> => {
  const running = context.runningHarness;
  if (!running) {
    return null;
  }
  const agent = harnessLabel(running, context.definitions);
  const model = await askReviewModelName(
    prompter,
    agent,
    answer.harnesses[running],
    3
  );
  if (model === null) {
    return null;
  }
  const effort = (await ask(
    prompter,
    AUTHORING_QUESTIONS.effort(agent),
    effortChoices()
  )) as AuthoringEffort;
  return { adversarial: true, effort, harness: running, model };
};

const ANY_REVIEWER: AuthoringRoleEntry = {
  adversarial: false,
  harness: RUNNING_HARNESS,
};

// Asks R1 and its follow-ups. A different-model choice that never yields an
// acceptable name goes back to R1, so only an explicit "Any independent
// reviewer" records a non-adversarial review; after three rounds without an
// answer nothing is recorded and the question stays pending.
const askReview = async (
  context: AuthoringOnboardingContext,
  prompter: AuthoringPrompter,
  answer: AuthoringSidecar,
  roundsLeft = 3
): Promise<AuthoringRoleEntry | null> => {
  if (roundsLeft === 0) {
    return null;
  }
  const reviewer = await ask(
    prompter,
    AUTHORING_QUESTIONS.reviewer,
    reviewerChoices({
      recordedHarnesses: Object.keys(answer.harnesses),
      runningHarness: context.runningHarness,
    })
  );
  if (reviewer === "any") {
    return ANY_REVIEWER;
  }
  const role =
    reviewer === "different-agent"
      ? await askDifferentAgent(context, prompter, answer)
      : await askDifferentModel(context, prompter, answer);
  if (!role) {
    prompter.present?.(
      "No different reviewer model was named; choose again, or pick Any independent reviewer."
    );
    return askReview(context, prompter, answer, roundsLeft - 1);
  }
  const escalation = await ask(
    prompter,
    AUTHORING_QUESTIONS.escalation,
    escalationChoices()
  );
  return {
    ...role,
    escalateOnFindings: escalation === "xhigh" ? "xhigh" : null,
  };
};

/**
 * Runs the authoring questions for one setup. Recommended and run-only setup
 * record the default for every detected harness without asking the model
 * questions; Customize and the walkthrough ask Question A and one model
 * question per selected harness. The review questions follow their own
 * trigger. Returns the sidecar to save (run-only callers save nothing).
 */
export const collectAuthoringAnswers = async (
  context: AuthoringOnboardingContext,
  prompter: AuthoringPrompter
): Promise<AuthoringSidecar> => {
  const customize =
    context.setupStyle === "customize" || context.setupStyle === "walkthrough";
  let answer = recommendedAuthoringAnswer(
    context.detected.map((harness) => harness.id)
  );
  if (customize) {
    prompter.present?.(
      "Simple Changes can hand proposal writing and reviews to a specific model, but only inside the coding agents you actually use."
    );
    const agents = orderHarnessIds(
      await selectAgents(context, prompter),
      context.definitions
    );
    const models = await sequentially(agents, (id) =>
      askModel(
        prompter,
        harnessLabel(id, context.definitions),
        PROPOSALS_PURPOSE
      )
    );
    const harnesses: AuthoringSidecar["harnesses"] = Object.fromEntries(
      agents.map((id, index) => [id, models[index] ?? null])
    );
    answer = { ...answer, harnesses };
  }
  if (
    asksReviewQuestions({
      answers: answer,
      detectedCount: context.detected.length,
      setupStyle: context.setupStyle,
    })
  ) {
    prompter.present?.(
      "A review from a different agent catches what the author's own model tends to miss, and self-review is never counted as independent."
    );
    const review = await askReview(context, prompter, answer);
    if (review) {
      answer.roles.review = review;
    }
  }
  prompter.present?.(AUTHORING_PREFERENCE_NOTE);
  return answer;
};

const describeEntry = (
  entry: AuthoringSidecar["harnesses"][string] | undefined
): string => {
  if (entry === null) {
    return "not guided";
  }
  const model =
    !entry || entry.model === MOST_CAPABLE
      ? "the most capable model"
      : entry.model;
  return `${model} at ${entry?.effort ?? "xhigh"}`;
};

/** One receipt line per role, in plain language. */
export const renderAuthoringSummary = (
  answer: AuthoringSidecar,
  definitions: readonly HarnessDefinition[]
): string => {
  const agents = orderHarnessIds(Object.keys(answer.harnesses), definitions);
  const lines = [
    agents.length > 0
      ? `Proposal text: written in the running agent by ${agents
          .map(
            (id) =>
              `${harnessLabel(id, definitions)}: ${describeEntry(answer.harnesses[id])}`
          )
          .join("; ")}.`
      : "Proposal text: the running agent's most capable model at xhigh.",
  ];
  const { review } = answer.roles;
  if (review) {
    const effort = review.effort ? ` at ${review.effort}` : "";
    let reviewer = `any independent reviewer${effort}, as today`;
    if (review.adversarial && review.model) {
      reviewer = `${review.model}${effort} in ${harnessLabel(review.harness, definitions)}, never the author's model`;
    } else if (review.adversarial) {
      reviewer = `${harnessLabel(review.harness, definitions)}${effort}, an agent other than the author's`;
    }
    const floor = review.escalateOnFindings
      ? ` After findings, later reviews run at least at ${review.escalateOnFindings}.`
      : "";
    lines.push(`Independent reviews: ${reviewer}.${floor}`);
  }
  lines.push(AUTHORING_PREFERENCE_NOTE);
  return lines.join("\n");
};

/**
 * Question R1 as an update-notice required answer, for existing
 * repositories whose review question is pending. Detection triggers it; its
 * options follow the onboarding rules for the agents recorded when it is
 * answered: those in the sidecars once the models question is answered, or,
 * while that is pending and asked first, the recommended answer to it (every
 * detected agent). Null when fewer than two answers are possible here (one
 * recorded agent and no identified running agent): there is nothing to
 * choose until the owner records another agent. The answer is recorded with
 * `setup --authoring`.
 */
export const authoringReviewNoticeQuestion = (input: {
  definitions: readonly HarnessDefinition[];
  detected: readonly DetectedHarness[];
  modelsPending: boolean;
  recordedHarnesses: readonly string[];
  runningHarness: string | null;
}): {
  choices: AuthoringChoice[];
  id: string;
  question: string;
  reason: string;
  setting: string;
} | null => {
  const choices = reviewerChoices({
    recordedHarnesses: input.modelsPending
      ? input.detected.map((harness) => harness.id)
      : input.recordedHarnesses,
    runningHarness: input.runningHarness,
  });
  if (choices.length < 2) {
    return null;
  }
  return {
    choices,
    id: "authoring-review",
    question: AUTHORING_QUESTIONS.reviewer,
    reason: `More than one coding agent was detected (${namesOf(
      orderHarnessIds(
        input.detected.map((harness) => harness.id),
        input.definitions
      ),
      input.definitions
    )}), so reviews can come from a different agent than the one that wrote the change. A review from a different agent catches what the author's own model tends to miss.`,
    setting: "roles.review in the authoring sidecar (setup --authoring)",
  };
};
