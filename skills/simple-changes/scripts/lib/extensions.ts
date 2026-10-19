// Forward-compatible extension points for the strictly validated files that
// runtimes of different versions share: the review ledger and the authoring
// sidecar. Each record that has one may carry a single `extensions` object
// beside its own keys. A reader accepts any members in it without
// interpreting them, and a writer keeps them byte for byte through a
// read-modify-write, so a newer runtime can add a field without breaking an
// older reader. Nothing writes `extensions` today, so a new file holds none.
//
// The rule for what may go there: a field whose absence, or a reader's
// ignorance of it, can only make that reader stricter, never looser. For
// example, an ungraded finding still escalates, so graded severities would
// qualify. A field that could loosen a gate must sit outside `extensions`,
// where a reader that does not know it refuses the whole record.
//
// A writer serializes what it parsed, so members are kept exactly only when
// their text is already spelled the way JSON.stringify spells it. Every
// Simple Changes runtime writes JSON that way; text spelled otherwise (an
// integer past 2^53, `1e400`, `1.0`, `-0`, an optional escape, integer-like
// keys out of order, a repeated key) would change on a write, so writers
// refuse it instead.

export const EXTENSIONS_KEY = "extensions";

/** Members a newer runtime recorded beside a record; kept and never read. */
export type RecordExtensions = Record<string, unknown>;

/** Why an unknown key beside an `extensions` object may be there. */
export const NEWER_RUNTIME_HINT =
  "a newer Simple Changes may have written it; update this runtime";

/**
 * The error text for a key a record does not allow. At a record that has
 * `extensions`, an unknown key most likely came from a newer runtime, so the
 * text says how to recover.
 */
export const unknownKeyMessage = (extensible: boolean): string =>
  extensible ? `is not allowed (${NEWER_RUNTIME_HINT})` : "is not allowed";

// A JSON string token, or a run of whitespace between tokens.
const STRING_OR_WHITESPACE = /"(?:[^"\\]|\\.)*"|[\t\n\r ]+/gsu;

/**
 * Whether `text`, which parses to `value`, spells it exactly as
 * JSON.stringify does, apart from whitespace between tokens. Serializing the
 * parsed value then reproduces every number, string, key and key order the
 * text holds.
 */
export const spelledAsSerialized = (text: string, value: unknown): boolean =>
  text.replace(STRING_OR_WHITESPACE, (token) =>
    token.startsWith('"') ? token : ""
  ) === JSON.stringify(value);
