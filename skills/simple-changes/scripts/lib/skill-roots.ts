import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The skill directory that ships `script`: `<root>/scripts/<file>` in place,
 * or `<root>/runtime/scripts/<file>` in a fork that keeps the upstream runtime
 * under `runtime/`. Null when neither directory holds a SKILL.md.
 */
export const skillRootOf = (script: string): string | null => {
  const scripts = dirname(resolve(script));
  for (const candidate of [dirname(scripts), dirname(dirname(scripts))]) {
    if (existsSync(resolve(candidate, "SKILL.md"))) {
      return candidate;
    }
  }
  return null;
};
