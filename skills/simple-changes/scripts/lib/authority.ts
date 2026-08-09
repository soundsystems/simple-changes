import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import type {
  Authority,
  ChangePlan,
  PlannedOperation,
  RepoPolicy,
  RequestMode,
} from "./types.ts";

const MODE_AUTHORITIES: Record<RequestMode, ReadonlySet<Authority>> = {
  integrate: new Set([
    "local-write",
    "proposal-write",
    "merge",
    "remote-branch-delete",
  ]),
  pause: new Set(),
  preview: new Set(),
  queue: new Set(["local-write", "proposal-write"]),
  reconcile: new Set([
    "local-write",
    "proposal-write",
    "merge",
    "remote-branch-delete",
  ]),
  resume: new Set(),
  ship: new Set([
    "local-write",
    "proposal-write",
    "merge",
    "preview-deploy",
    "remote-branch-delete",
  ]),
  sweep: new Set(["local-write", "proposal-write"]),
  sync: new Set(["local-sync"]),
};

const OPERATION_AUTHORITY: Partial<Record<PlannedOperation, Authority>> = {
  "apply-migration": "remote-data-write",
  branch: "local-write",
  cleanup: "local-write",
  commit: "local-write",
  "deploy-preview": "preview-deploy",
  "deploy-production": "production-deploy",
  "fast-forward-target": "local-sync",
  "fetch-target": "local-sync",
  merge: "merge",
  "merge-target": "local-sync",
  "open-proposal": "proposal-write",
  "promote-deployment": "production-deploy",
  push: "proposal-write",
  "reconcile-managed-targets": "production-deploy",
  "reconcile-remote-branches": "remote-branch-delete",
  "update-proposal": "proposal-write",
};

export const authoritiesForMode = (
  mode: RequestMode,
  policy: RepoPolicy
): ReadonlySet<Authority> => {
  const authorities = new Set(MODE_AUTHORITIES[mode]);
  if (mode === "ship" && policy.productionDeploy === "allow") {
    authorities.add("production-deploy");
  }
  return authorities;
};

export const validatePlanAuthority = (
  plan: ChangePlan,
  policy: RepoPolicy
): void => {
  const allowed = authoritiesForMode(plan.mode, policy);
  if (
    plan.mode === "preview" &&
    (plan.mutationsAllowed || plan.mutationCount > 0)
  ) {
    throw new SimpleChangesError(
      "Preview plans must contain zero mutations",
      EXIT_CODES.validation
    );
  }
  for (const unit of plan.units) {
    for (const authority of unit.requiredAuthority) {
      if (!allowed.has(authority)) {
        throw new SimpleChangesError(
          `Unit ${unit.id} requires unauthorized capability ${authority}`,
          EXIT_CODES.validation
        );
      }
    }
    for (const operation of unit.operations) {
      const required = OPERATION_AUTHORITY[operation];
      if (required && !allowed.has(required)) {
        throw new SimpleChangesError(
          `Operation ${operation} is not authorized in ${plan.mode} mode`,
          EXIT_CODES.validation
        );
      }
    }
  }
};
