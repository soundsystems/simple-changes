import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalModelId, MODEL_ID_REQUIRED } from "./authoring.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { resolveHarnessSession } from "./harness-session.ts";
import { validateSchema } from "./schema.ts";
import type { LoopControllerSession } from "./types.ts";

type Environment = Record<string, string | undefined>;

/**
 * What the harness running a command reports about itself: which session the
 * command runs in, and the model and agent instance running it. A harness
 * or its wrapper supplies it with `--identity-receipt`. It is checked
 * against the session the environment reports and never stored, so it
 * corrects a confused identity, such as a session variable inherited from a
 * parent harness, without being treated as proof against a forged one: the
 * environment is trusted, and the receipt can never name a session the
 * environment does not show.
 */
export interface IdentityReceipt {
  harness: string;
  instance?: string | null;
  model: string;
  parentSession?: string | null;
  schemaVersion: 1;
  session: string;
}

const OPTION = "--identity-receipt";

const refuse = (message: string, cause?: unknown): SimpleChangesError =>
  cause === undefined
    ? new SimpleChangesError(message, EXIT_CODES.usage)
    : SimpleChangesError.withCause(message, EXIT_CODES.usage, cause);

/**
 * Parses `--identity-receipt`: JSON text, or `@path` to a JSON file, checked
 * against its closed schema. Anything invalid is a usage error raised before
 * the command reads or writes anything else.
 */
export const parseIdentityReceipt = (text: string): IdentityReceipt => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      text.startsWith("@") ? readFileSync(resolve(text.slice(1)), "utf8") : text
    ) as unknown;
  } catch (error) {
    throw refuse(
      `${OPTION} must be JSON or @path to a JSON file: ${(error as Error).message}`,
      error
    );
  }
  let receipt: IdentityReceipt;
  try {
    receipt = validateSchema<IdentityReceipt>("identity-receipt", parsed);
  } catch (error) {
    throw refuse(
      `${OPTION} is not a valid identity receipt: ${(error as Error).message}`,
      error
    );
  }
  if (canonicalModelId(receipt.model) === null) {
    throw refuse(
      `${OPTION} names the model ${JSON.stringify(receipt.model)}, which is not a model ID. ${MODEL_ID_REQUIRED}`
    );
  }
  if (receipt.parentSession === receipt.session) {
    throw refuse(
      `${OPTION} names its own session as its parent session; a parent is the session that started this one.`
    );
  }
  return receipt;
};

/** What the command's own arguments say about the executing identity. */
export interface StatedIdentity {
  /** `--agent`: the model the agent says it runs. */
  agent?: string | null;
  /** `--harness`: the harness the agent says it runs in. */
  harness?: string | null;
  /** `--instance`: the agent instance the agent reports. */
  instance?: string | null;
  /** `--session`: the session the agent says it runs in. */
  session?: string | null;
}

// Each argument beside a receipt must say what the receipt says: the same
// harness, session and instance, and the same model ID.
const statedConflict = (
  receipt: IdentityReceipt,
  stated: StatedIdentity
): string | null => {
  const harness = stated.harness?.trim();
  if (harness && harness !== receipt.harness) {
    return `--harness ${harness} disagrees with the identity receipt, which names ${receipt.harness}.`;
  }
  const session = stated.session?.trim();
  if (session && session !== receipt.session) {
    return `--session ${session} disagrees with the identity receipt, which names ${receipt.session}.`;
  }
  const agent = stated.agent?.trim();
  if (agent && canonicalModelId(agent) !== canonicalModelId(receipt.model)) {
    return `--agent ${agent} disagrees with the identity receipt's model ${receipt.model}.`;
  }
  const instance = stated.instance?.trim();
  const reported = receipt.instance ?? null;
  if (instance && reported !== null && instance !== reported) {
    return `--instance ${instance} disagrees with the identity receipt's instance ${reported}.`;
  }
  return null;
};

/**
 * The executing session a receipt names, once everything else agrees with
 * it: the arguments beside it, and the environment, where the receipt's
 * harness must have its own session variable set, holding the receipt's
 * session. Any disagreement is a usage error, so no command acts under an
 * identity two sources dispute.
 */
export const receiptSession = (
  receipt: IdentityReceipt,
  environment: Environment,
  stated: StatedIdentity = {}
): LoopControllerSession => {
  const conflict = statedConflict(receipt, stated);
  if (conflict) {
    throw refuse(conflict);
  }
  const resolution = resolveHarnessSession(environment, receipt.harness);
  if (!resolution.session) {
    throw refuse(
      `The identity receipt names a ${receipt.harness} session, but this process reports ${resolution.present.length > 0 ? `only ${resolution.present.join(" and ")} sessions` : "no harness session"}; a receipt must agree with the session the environment reports.`
    );
  }
  if (resolution.session.sessionId !== receipt.session) {
    throw refuse(
      `The identity receipt names ${receipt.harness} session ${receipt.session}, but the environment reports ${resolution.session.sessionId} for that harness; a receipt must agree with the session the environment reports.`
    );
  }
  return resolution.session;
};
