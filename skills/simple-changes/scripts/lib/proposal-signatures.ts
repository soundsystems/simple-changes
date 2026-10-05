import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { assertSafeRelativePath } from "./path-safety.ts";
import { runGit } from "./process.ts";

export type ProposalSignatureRole = "authored" | "reviewed" | "merged";

export type ProposalCreditRole =
  | ProposalSignatureRole
  | "co-authored"
  | "changelog";

export interface ProposalCredit {
  agent: string;
  /** Where the credit was proven: `self`, a commit SHA, or a changelog path. */
  evidence: string;
  line: string;
  role: ProposalCreditRole;
}

export interface ProposalSignatureInput {
  /** Merge base or target ref; credits come from commits after it. */
  baseRef?: string;
  /** Changelog paths written for this shipment, normally the receipt's `paths`. */
  changelogPaths?: readonly string[];
  headRef?: string;
  repositoryPath: string;
  self?: { agent: string; role: ProposalSignatureRole };
}

export interface ProposalSignatureBlock {
  block: string;
  credits: ProposalCredit[];
}

const ROLE_LABELS: Record<ProposalCreditRole, string> = {
  authored: "Authored by",
  changelog: "Changelog by",
  "co-authored": "Co-authored by",
  merged: "Merged by",
  reviewed: "Reviewed by",
};

/** One signature line of a proposal's signature block. */
export const SIGNATURE_LINE_PATTERN = new RegExp(
  `^\\[\\[(?:${Object.values(ROLE_LABELS).join("|")}) \\S.*\\]\\]$`,
  "u"
);

const EMAIL_SUFFIX = /\s*<[^>]*>\s*$/u;
const CLAUDE_FAMILY_PREFIX = /^claude\s+/iu;
const CHANGELOG_SIGNATURE =
  /<!--\s*simple-changelogs-signature\s+agent="([^"]*)"[^>]*-->/gu;
const REF_PATTERN = /^[^\s-][^\s]*$/u;

/**
 * The public model name and version as the harness reports it. Commit
 * trailers carry `Claude Fable 5.1 <email>`; the signature line uses
 * `Fable 5.1`, so the family prefix and the address are dropped.
 */
export const normalizeAgentName = (value: string): string =>
  value.replace(EMAIL_SUFFIX, "").replace(CLAUDE_FAMILY_PREFIX, "").trim();

export const signatureLine = (
  role: ProposalCreditRole,
  agent: string
): string => `[[${ROLE_LABELS[role]} ${agent}]]`;

const requiredRef = (value: string, name: string): string => {
  const trimmed = value.trim();
  if (!REF_PATTERN.test(trimmed)) {
    throw new SimpleChangesError(
      `${name} must be a plain Git reference.`,
      EXIT_CODES.usage
    );
  }
  return trimmed;
};

const commitCredits = (
  repositoryPath: string,
  baseRef: string,
  headRef: string
): ProposalCredit[] => {
  const log = runGit(repositoryPath, [
    "log",
    "--format=%H%x1f%(trailers:key=Co-Authored-By,valueonly)%x1e",
    `${requiredRef(baseRef, "base")}..${requiredRef(headRef, "head")}`,
  ]);
  const credits: ProposalCredit[] = [];
  for (const record of log.stdout.split("\x1e")) {
    const [sha, trailers] = record.trim().split("\x1f");
    if (!(sha && trailers)) {
      continue;
    }
    for (const value of trailers.split("\n")) {
      const agent = normalizeAgentName(value);
      if (agent) {
        credits.push({
          agent,
          evidence: sha,
          line: signatureLine("co-authored", agent),
          role: "co-authored",
        });
      }
    }
  }
  return credits;
};

const changelogCredits = (
  repositoryPath: string,
  baseRef: string,
  headRef: string,
  paths: readonly string[]
): ProposalCredit[] => {
  if (paths.length === 0) {
    return [];
  }
  for (const path of paths) {
    assertSafeRelativePath(repositoryPath, path);
  }
  const range = `${requiredRef(baseRef, "base")}..${requiredRef(headRef, "head")}`;
  const credits: ProposalCredit[] = [];
  for (const path of paths) {
    const addedContents = runGit(repositoryPath, [
      "diff",
      "--no-ext-diff",
      "--unified=0",
      range,
      "--",
      path,
    ])
      .stdout.split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1))
      .join("\n");
    for (const match of addedContents.matchAll(CHANGELOG_SIGNATURE)) {
      const agent = normalizeAgentName(match[1] ?? "");
      if (agent) {
        credits.push({
          agent,
          evidence: path,
          line: signatureLine("changelog", agent),
          role: "changelog",
        });
      }
    }
  }
  return credits;
};

const dedupe = (credits: ProposalCredit[]): ProposalCredit[] => {
  const seen = new Set<string>();
  return credits.filter((credit) => {
    const key = `${credit.role}\u0000${credit.agent.toLowerCase()}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

/**
 * Build the proposal signature block from evidence only: the acting agent's
 * own line first, then every distinct co-author named by a commit trailer
 * after the base, then every distinct agent that signed a changelog entry
 * written for this shipment. Nothing is inferred from titles or prose.
 */
export const buildProposalSignatureBlock = (
  input: ProposalSignatureInput
): ProposalSignatureBlock => {
  if (
    (input.changelogPaths?.length ?? 0) > 0 &&
    !(input.baseRef && input.headRef)
  ) {
    throw new SimpleChangesError(
      "base and head refs are required to credit changelog changes.",
      EXIT_CODES.usage
    );
  }
  const credits: ProposalCredit[] = [];
  if (input.self) {
    const agent = normalizeAgentName(input.self.agent);
    if (!agent) {
      throw new SimpleChangesError("agent name is required.", EXIT_CODES.usage);
    }
    credits.push({
      agent,
      evidence: "self",
      line: signatureLine(input.self.role, agent),
      role: input.self.role,
    });
  }
  if (input.baseRef && input.headRef) {
    credits.push(
      ...commitCredits(input.repositoryPath, input.baseRef, input.headRef)
    );
  }
  if (input.baseRef && input.headRef) {
    credits.push(
      ...changelogCredits(
        input.repositoryPath,
        input.baseRef,
        input.headRef,
        input.changelogPaths ?? []
      )
    );
  }
  const distinct = dedupe(credits).filter(
    (credit) =>
      credit.evidence === "self" ||
      !input.self ||
      credit.agent.toLowerCase() !==
        normalizeAgentName(input.self.agent).toLowerCase()
  );
  return {
    block: distinct.map((credit) => credit.line).join("\n"),
    credits: distinct,
  };
};
