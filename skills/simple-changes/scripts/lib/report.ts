import type { ChangePlan, RepositoryInventory } from "./types.ts";

export const renderInventory = (inventory: RepositoryInventory): string => {
  const dirtyWorktrees = inventory.worktrees.filter(
    (worktree) => worktree.changes.length > 0
  );
  const lines = [
    "Simple Changes inventory",
    `Repository: ${inventory.repository.root}`,
    `Primary checkout: ${inventory.repository.primaryCheckout}`,
    `Current checkout: ${inventory.repository.currentCheckout}`,
    `Target: ${inventory.targetRef}`,
    `Worktrees: ${inventory.worktrees.length} (${dirtyWorktrees.length} dirty)`,
    `Local changes: ${inventory.localChanges.length}`,
    `Branches: ${inventory.branches.length}`,
    `Stashes: ${inventory.stashes.length}`,
    `Policy: ${inventory.policy.source}`,
    `Baseline: ${inventory.baselineDigest}`,
  ];
  return `${lines.join("\n")}\n`;
};

export const renderPlan = (plan: ChangePlan): string => {
  const lines = [
    "Simple Changes preview",
    `Repository: ${plan.repositoryRoot}`,
    `Ready units: ${plan.units.length}`,
    `Preserved items: ${plan.preserved.length}`,
    "Mutations: 0",
  ];
  for (const unit of plan.units) {
    lines.push(
      "",
      `- ${unit.title}`,
      `  Outcome: ${unit.outcome}`,
      `  Paths: ${unit.paths.join(", ")}`,
      `  Checks: ${unit.checks.join(", ")}`
    );
  }
  for (const item of plan.preserved) {
    lines.push(
      "",
      `- Preserved (${item.classification}): ${item.worktreePath}`,
      `  Reason: ${item.reason}`
    );
  }
  for (const warning of plan.warnings) {
    lines.push("", `Warning: ${warning}`);
  }
  return `${lines.join("\n")}\n`;
};
