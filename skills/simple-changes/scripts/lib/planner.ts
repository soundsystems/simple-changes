import { existsSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { authoritiesForMode, validatePlanAuthority } from "./authority.ts";
import { dataChangeKinds } from "./data-changes.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { sha256 } from "./hash.ts";
import { assertSafeRelativePath } from "./path-safety.ts";
import { validateSchema } from "./schema.ts";
import type {
  ChangePlan,
  ChangeUnit,
  GitChange,
  RepoPolicy,
  RepositoryInventory,
  RequestMode,
  SnapshotComparison,
  WorktreeInventory,
} from "./types.ts";

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);
const slugify = (value: string): string => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug || "root";
};

const groupKey = (path: string): string => {
  const [first] = path.split("/");
  return path.includes("/") ? (first ?? "root") : "root";
};

const availableChecks = (
  worktree: WorktreeInventory,
  paths: string[]
): string[] => {
  const checks = ["git diff --check"];
  const packagePath = `${worktree.path}/package.json`;
  if (!existsSync(packagePath)) {
    return checks;
  }
  try {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};
    for (const script of ["typecheck", "lint", "test", "build"]) {
      if (scripts[script]) {
        checks.push(`bun run ${script}`);
      }
    }
  } catch {
    checks.push("Inspect invalid package.json before packaging");
  }
  const detectedDataChangeKinds = dataChangeKinds(paths);
  if (detectedDataChangeKinds.length > 0) {
    checks.push(
      `Run repository-native data-change audit (${detectedDataChangeKinds.join(", ")})`
    );
  }
  return checks;
};

const releaseImpact = (paths: string[]): ChangeUnit["releaseImpact"] => {
  if (paths.every((path) => DOC_EXTENSIONS.has(extname(path).toLowerCase()))) {
    return "none";
  }
  return "unknown";
};

const buildUnitsForWorktree = (
  worktree: WorktreeInventory,
  mode: RequestMode,
  policy: RepoPolicy,
  usedIds: Set<string>
): ChangeUnit[] => {
  const safeChanges: GitChange[] = [];
  for (const change of worktree.changes) {
    const safety = assertSafeRelativePath(worktree.path, change.path);
    if (!(safety.symlink || change.symlink || change.conflicted)) {
      safeChanges.push(change);
    }
  }
  const grouped = new Map<string, string[]>();
  for (const change of safeChanges) {
    const key = groupKey(change.path);
    const paths = grouped.get(key) ?? [];
    paths.push(change.path);
    grouped.set(key, paths);
  }

  const allowed = authoritiesForMode(mode, policy);
  const units: ChangeUnit[] = [];
  for (const [key, paths] of [...grouped.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const branchLabel = worktree.branch ?? basename(worktree.path);
    const baseId = slugify(`${branchLabel}-${key}`);
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    const operations =
      mode === "preview"
        ? []
        : (["branch", "commit", "push", "open-proposal"] as const).filter(
            (operation) => {
              if (operation === "branch" || operation === "commit") {
                return allowed.has("local-write");
              }
              return allowed.has("proposal-write");
            }
          );
    const requiredAuthority = [
      ...(operations.some(
        (operation) => operation === "branch" || operation === "commit"
      )
        ? (["local-write"] as const)
        : []),
      ...(operations.some(
        (operation) => operation === "push" || operation === "open-proposal"
      )
        ? (["proposal-write"] as const)
        : []),
    ];
    const sortedPaths = [...new Set(paths)].sort();
    units.push({
      checks: availableChecks(worktree, sortedPaths),
      dependencies: [],
      id,
      operations: [...operations],
      outcome: `Package the stable ${key === "root" ? "repository-level" : key} work as one reviewable outcome.`,
      paths: sortedPaths,
      releaseImpact: releaseImpact(sortedPaths),
      requiredAuthority,
      sourceWorktree: worktree.path,
      status: "ready",
      title: `Prepare ${key === "root" ? "repository-level" : key} changes`,
    });
  }
  return units;
};

const preservedUnsafe = (worktree: WorktreeInventory) => {
  const paths = worktree.changes
    .filter((change) => change.symlink || change.conflicted)
    .map((change) => change.path)
    .sort((left, right) => left.localeCompare(right));
  if (paths.length === 0) {
    return null;
  }
  return {
    classification: "unsafe" as const,
    paths,
    reason:
      "Conflicted or symlinked paths require explicit inspection before packaging.",
    worktreePath: worktree.path,
  };
};

export const buildPreviewPlan = (
  opening: RepositoryInventory,
  current: RepositoryInventory,
  comparison: SnapshotComparison,
  request = "Show me what you would do with everything ready"
): ChangePlan => {
  const usedIds = new Set<string>();
  const units = comparison.stableWorktrees.flatMap((worktree) =>
    buildUnitsForWorktree(worktree, "preview", current.policy.value, usedIds)
  );
  const preserved = [
    ...comparison.concurrentWorktrees.map((worktree) => ({
      classification: "concurrent-arrival" as const,
      paths: worktree.changes.map((change) => change.path).sort(),
      reason: "This worktree first appeared after the opening baseline.",
      worktreePath: worktree.path,
    })),
    ...comparison.activelyChangingWorktrees.map((worktree) => ({
      classification: "actively-changing" as const,
      paths: worktree.changes.map((change) => change.path).sort(),
      reason: "Its revision or change digest changed between snapshots.",
      worktreePath: worktree.path,
    })),
    ...comparison.stableWorktrees
      .map(preservedUnsafe)
      .filter((item) => item !== null),
  ];
  const warnings: string[] = [];
  if (current.localChanges.length === 0) {
    warnings.push("No local changes were found.");
  }
  if (
    opening.repository.primaryCheckout !== current.repository.primaryCheckout
  ) {
    warnings.push("The canonical primary checkout changed between snapshots.");
  }
  const plan: ChangePlan = {
    baselineDigest: opening.baselineDigest,
    exclusions: [],
    generatedAt: new Date().toISOString(),
    mode: "preview",
    mutationCount: 0,
    mutationsAllowed: false,
    preserved,
    questions: [],
    repositoryRoot: current.repository.root,
    request,
    schemaVersion: 1,
    units,
    warnings,
  };
  validateSchema<ChangePlan>("change-plan", plan);
  validatePlanConservation(plan, current);
  validatePlanAuthority(plan, current.policy.value);
  return plan;
};

export const validatePlanConservation = (
  plan: ChangePlan,
  inventory: RepositoryInventory
): void => {
  const expected = new Set(
    inventory.localChanges.map(
      (change) => `${change.worktreePath}\0${change.path}`
    )
  );
  const accounted = new Set<string>();
  const addAccounted = (key: string): void => {
    if (accounted.has(key)) {
      throw new SimpleChangesError(
        `Changed path is accounted for more than once: ${key.replace("\0", ":")}`,
        EXIT_CODES.validation
      );
    }
    accounted.add(key);
  };

  for (const unit of plan.units) {
    for (const path of unit.paths) {
      assertSafeRelativePath(unit.sourceWorktree, path);
      addAccounted(`${unit.sourceWorktree}\0${path}`);
    }
  }
  for (const item of plan.preserved) {
    for (const path of item.paths) {
      assertSafeRelativePath(item.worktreePath, path);
      addAccounted(`${item.worktreePath}\0${path}`);
    }
  }
  for (const exclusion of plan.exclusions) {
    const matches = [...expected].filter((key) =>
      key.endsWith(`\0${exclusion.path}`)
    );
    if (matches.length !== 1) {
      throw new SimpleChangesError(
        `Excluded path must resolve to exactly one changed path: ${exclusion.path}`,
        EXIT_CODES.validation
      );
    }
    addAccounted(matches[0] ?? "");
  }

  const missing = [...expected].filter((key) => !accounted.has(key));
  const unexpected = [...accounted].filter((key) => !expected.has(key));
  if (missing.length > 0 || unexpected.length > 0) {
    const details = [
      missing.length > 0
        ? `missing ${missing.map((key) => key.replace("\0", ":")).join(", ")}`
        : "",
      unexpected.length > 0
        ? `unexpected ${unexpected
            .map((key) => key.replace("\0", ":"))
            .join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join("; ");
    throw new SimpleChangesError(
      `Plan does not conserve repository changes: ${details}`,
      EXIT_CODES.validation
    );
  }
};

export const planFingerprint = (plan: ChangePlan): string =>
  sha256(
    JSON.stringify({
      baselineDigest: plan.baselineDigest,
      exclusions: plan.exclusions,
      mode: plan.mode,
      preserved: plan.preserved,
      units: plan.units,
    })
  );
