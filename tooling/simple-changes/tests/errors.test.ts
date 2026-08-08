import { describe, expect, test } from "bun:test";
import {
  EXIT_CODES,
  SimpleChangesError,
} from "../../../skills/simple-changes/scripts/lib/errors";

describe("SimpleChangesError", () => {
  test("preserves the original cause without inline lint suppressions", () => {
    const cause = new Error("lock creation failed");
    const error = SimpleChangesError.withCause(
      "Active-loop state is busy.",
      EXIT_CODES.unsafe,
      cause
    );

    expect(error).toBeInstanceOf(SimpleChangesError);
    expect(error.exitCode).toBe(EXIT_CODES.unsafe);
    expect(error.cause).toBe(cause);
  });
});
