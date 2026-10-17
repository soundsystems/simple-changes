/**
 * The grammar of a loop run ID: `run-` followed by lowercase letters, digits,
 * and hyphens. `loop start` mints IDs in this form and the loop-lease schema
 * pins the same pattern. Every path built from a run ID checks it first: it
 * admits no dot, separator, or other character that could name the parent
 * directory or a sibling run's files.
 */
export const RUN_ID_PATTERN = /^run-[a-z0-9-]+$/u;
