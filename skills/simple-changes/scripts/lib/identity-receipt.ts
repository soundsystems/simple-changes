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

/**
 * The executing session a receipt names, once the environment agrees: the
 * receipt's harness must have its own session variable set here, holding the
 * receipt's session. A `--harness` passed beside it must name the same
 * harness. Any disagreement is a usage error, so nothing is recorded under an
 * identity the two sources dispute.
 */
export const receiptSession = (
  receipt: IdentityReceipt,
  environment: Environment,
  requestedHarness: string | null = null
): LoopControllerSession => {
  if (requestedHarness !== null && requestedHarness !== receipt.harness) {
    throw refuse(
      `--harness ${requestedHarness} disagrees with the identity receipt, which names ${receipt.harness}.`
    );
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
