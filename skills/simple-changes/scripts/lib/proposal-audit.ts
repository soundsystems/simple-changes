import {
  auditMarkdown,
  type MarkdownAudit,
  proseLines,
  withoutHtmlComments,
} from "./markdown.ts";
import { SIGNATURE_LINE_PATTERN } from "./proposal-signatures.ts";

export type ProposalDoor = "one-way" | "two-way" | "unknown";

export interface ProposalAudit {
  door: ProposalDoor | null;
  issues: string[];
  markdown: MarkdownAudit;
  missingSections: string[];
  requiredSections: string[];
  schemaVersion: 1;
  sectionSource: "default" | "template";
  signatureBlock: "absent" | "last" | "not-last";
  valid: boolean;
}

interface Heading {
  level: number;
  line: number;
  title: string;
}

interface Section {
  end: number;
  heading: Heading;
}

/** The body shape in references/change-requests.md#body-shape. */
const BODY_SHAPE: readonly Pick<Heading, "level" | "title">[] = [
  { level: 2, title: "Summary" },
  { level: 2, title: "Evidence" },
  { level: 2, title: "Merge danger" },
];
const MERGE_DANGER = "merge danger";
const LINE_BREAK_PATTERN = /\r?\n/u;
const WHITESPACE_RUN_PATTERN = /\s+/gu;
const ATX_HEADING_PATTERN =
  /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/u;
const DOOR_LINE_PATTERN =
  /^(?:[-*+][ \t]+)?\*\*Door(?::\*\*|\*\*:)[ \t]*(.*)$/iu;
const BLAST_RADIUS_LINE_PATTERN =
  /^(?:[-*+][ \t]+)?\*\*Blast radius(?::\*\*|\*\*:)[ \t]*(.*)$/iu;
const DOOR_VALUE_PATTERN = /^[`*_]*(one-way|two-way|unknown)(?![\w-])/iu;
const THEMATIC_BREAK_PATTERN = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/u;

const normalizedTitle = (title: string): string =>
  title.replace(WHITESPACE_RUN_PATTERN, " ").trim().toLowerCase();

const renderedHeading = (heading: Pick<Heading, "level" | "title">): string =>
  `${"#".repeat(heading.level)} ${heading.title}`;

interface MarkdownText {
  /** Lines with code blanked and HTML comments removed. */
  prose: string[];
  /** Lines with HTML comments removed and code kept. */
  source: string[];
}

const readMarkdown = (text: string): MarkdownText => ({
  prose: withoutHtmlComments(proseLines(text).join("\n")).split(
    LINE_BREAK_PATTERN
  ),
  source: withoutHtmlComments(text).split(LINE_BREAK_PATTERN),
});

/**
 * ATX headings outside code and HTML comments, in order. A heading is found in
 * prose so a fenced example never counts, and its title is read from the
 * source line so inline code in the title survives.
 */
const headingsOf = ({ prose, source }: MarkdownText): Heading[] =>
  prose.flatMap((line, index) => {
    const level = ATX_HEADING_PATTERN.exec(line)?.[1]?.length;
    const title = ATX_HEADING_PATTERN.exec(source[index] ?? "")?.[2]
      ?.replace(WHITESPACE_RUN_PATTERN, " ")
      .trim();
    return level && title ? [{ level, line: index, title }] : [];
  });

/** Each heading's section runs to the next heading at the same or a higher level. */
const sectionsOf = (
  headings: readonly Heading[],
  lineCount: number
): Section[] =>
  headings.map((heading, index) => ({
    end:
      headings.slice(index + 1).find((next) => next.level <= heading.level)
        ?.line ?? lineCount,
    heading,
  }));

const findSection = (
  sections: readonly Section[],
  wanted: Pick<Heading, "level" | "title">,
  matchLevel: boolean
): Section | undefined =>
  sections.find(
    ({ heading }) =>
      normalizedTitle(heading.title) === normalizedTitle(wanted.title) &&
      (!matchLevel || heading.level === wanted.level)
  );

interface MergeDangerResult {
  door: ProposalDoor | null;
  issues: string[];
}

// Find the Door and Blast radius lines in prose so a fenced example never
// counts, then read the value from the source line so `two-way` in inline
// code still names the door.
const auditMergeDanger = (
  section: Section,
  { prose, source }: MarkdownText
): MergeDangerResult => {
  const issues: string[] = [];
  const range = { from: section.heading.line + 1, to: section.end };
  const lineIndex = (pattern: RegExp): number => {
    for (let index = range.from; index < range.to; index += 1) {
      if (pattern.test(prose[index]?.trim() ?? "")) {
        return index;
      }
    }
    return -1;
  };
  const sourceLine = (index: number): string => (source[index] ?? "").trim();
  let door: ProposalDoor | null = null;
  const doorLine = lineIndex(DOOR_LINE_PATTERN);
  if (doorLine < 0) {
    issues.push(
      "The Merge danger section needs a **Door:** line naming one-way, two-way, or unknown."
    );
  } else {
    const value =
      DOOR_LINE_PATTERN.exec(sourceLine(doorLine))?.[1]?.trim() ?? "";
    const named = DOOR_VALUE_PATTERN.exec(value)?.[1]?.toLowerCase();
    if (named) {
      door = named as ProposalDoor;
    } else {
      issues.push(
        value
          ? `The **Door:** line must start with one-way, two-way, or unknown, not "${value}".`
          : "The **Door:** line is empty; start it with one-way, two-way, or unknown."
      );
    }
  }
  const blastLine = lineIndex(BLAST_RADIUS_LINE_PATTERN);
  if (
    blastLine < 0 ||
    !BLAST_RADIUS_LINE_PATTERN.exec(sourceLine(blastLine))?.[1]?.trim()
  ) {
    issues.push(
      "The Merge danger section needs a **Blast radius:** line naming what could break."
    );
  }
  return { door, issues };
};

interface SignatureResult {
  block: ProposalAudit["signatureBlock"];
  issues: string[];
}

const isBlank = (line: string | undefined): boolean => !line?.trim();

const isSignature = (line: string | undefined): boolean =>
  SIGNATURE_LINE_PATTERN.test(line?.trim() ?? "");

// The signature block is a horizontal rule followed by signature lines, and it
// ends the body. A `---` directly under text would instead turn that text into
// a heading, so the rule needs a blank line above it.
const auditSignatureBlock = (prose: readonly string[]): SignatureResult => {
  const signatures = prose.flatMap((line, position) =>
    isSignature(line) ? [position] : []
  );
  if (signatures.length === 0) {
    return { block: "absent", issues: [] };
  }
  let index = prose.length - 1;
  let blockStart = -1;
  while (index >= 0) {
    if (isBlank(prose[index])) {
      index -= 1;
    } else if (isSignature(prose[index])) {
      blockStart = index;
      index -= 1;
    } else {
      break;
    }
  }
  if (blockStart < 0 || signatures.some((line) => line < blockStart)) {
    return {
      block: "not-last",
      issues: [
        "The signature block must be the last element of the body; move every signature line below the rest of the description.",
      ],
    };
  }
  const rule = THEMATIC_BREAK_PATTERN.exec(prose[index] ?? "");
  if (!rule) {
    return {
      block: "last",
      issues: [
        "Put a horizontal rule (---) on its own line directly above the signature lines.",
      ],
    };
  }
  if (index > 0 && rule[1] === "-" && !isBlank(prose[index - 1])) {
    return {
      block: "last",
      issues: [
        "Leave a blank line above the --- before the signature block; without it the line above renders as a heading.",
      ],
    };
  }
  return { block: "last", issues: [] };
};

export interface ProposalAuditInput {
  body: string;
  /** The repository proposal template the body filled, when there is one. */
  template?: string | undefined;
}

/**
 * Check a proposal description against references/change-requests.md: real
 * line breaks, the Summary, Evidence, and Merge danger sections (or the
 * repository template's headings), a Merge danger door and blast radius, and a
 * signature block that ends the body.
 */
export const auditProposalBody = (input: ProposalAuditInput): ProposalAudit => {
  const markdown = auditMarkdown(input.body);
  const body = readMarkdown(input.body);
  const { prose, source } = body;
  const sections = sectionsOf(headingsOf(body), prose.length);
  const templateHeadings =
    input.template === undefined
      ? []
      : headingsOf(readMarkdown(input.template));
  const fromTemplate = templateHeadings.length > 0;
  // A template's own sections may hold the Summary and Evidence, but nothing
  // stands in for the door and blast radius, so Merge danger is required
  // beneath a template that has no such section.
  const mergeDangerHeading = BODY_SHAPE.find(
    (heading) => normalizedTitle(heading.title) === MERGE_DANGER
  );
  const templateHasMergeDanger = templateHeadings.some(
    (heading) => normalizedTitle(heading.title) === MERGE_DANGER
  );
  const required = (
    fromTemplate
      ? [
          ...templateHeadings,
          ...(templateHasMergeDanger || !mergeDangerHeading
            ? []
            : [mergeDangerHeading]),
        ]
      : BODY_SHAPE
  ).filter(
    (heading, index, all) =>
      all.findIndex(
        (other) =>
          other.level === heading.level &&
          normalizedTitle(other.title) === normalizedTitle(heading.title)
      ) === index
  );
  const issues = [...markdown.issues];
  const missingSections: string[] = [];
  for (const heading of required) {
    const section = findSection(sections, heading, true);
    if (!section) {
      missingSections.push(renderedHeading(heading));
      issues.push(`Missing the "${renderedHeading(heading)}" section.`);
    } else if (
      !fromTemplate &&
      normalizedTitle(heading.title) !== MERGE_DANGER &&
      source
        .slice(section.heading.line + 1, section.end)
        .every((line) => isBlank(line))
    ) {
      issues.push(`The "${renderedHeading(heading)}" section is empty.`);
    }
  }
  const mergeDanger = findSection(
    sections,
    { level: 2, title: MERGE_DANGER },
    false
  );
  const danger = mergeDanger
    ? auditMergeDanger(mergeDanger, body)
    : { door: null, issues: [] };
  issues.push(...danger.issues);
  const signature = auditSignatureBlock(prose);
  issues.push(...signature.issues);
  return {
    door: danger.door,
    issues,
    markdown,
    missingSections,
    requiredSections: required.map(renderedHeading),
    schemaVersion: 1,
    sectionSource: fromTemplate ? "template" : "default",
    signatureBlock: signature.block,
    valid: issues.length === 0,
  };
};
