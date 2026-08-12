import { describe, expect, test } from "bun:test";
import {
  decideEmergencyShipping,
  deriveEmergencyShippingStatus,
} from "../../../skills/simple-changes/scripts/lib/emergency-shipping.ts";
import type { EmergencyShippingLedgerEntry } from "../../../skills/simple-changes/scripts/lib/types.ts";

const revisionA = "a".repeat(40);
const revisionB = "b".repeat(40);

const state = (
  overrides: Partial<EmergencyShippingLedgerEntry> = {}
): EmergencyShippingLedgerEntry => ({
  artifactEquivalenceProven: false,
  authoritySource: null,
  breakGlassAuthorized: false,
  candidateArtifactId: "artifact-a",
  candidateRevision: revisionA,
  candidateVerifiedHealthy: false,
  canonicalArtifactId: null,
  canonicalRevision: null,
  changelogReconciled: false,
  cleanupCompleted: false,
  deployedArtifactId: null,
  deployedRevision: null,
  evidence: ["urgency-language"],
  finalVerificationPassed: false,
  focusedChecksPassed: false,
  independentReview: "pending",
  mergeCompleted: false,
  mode: "expedited",
  previousProductionRevision: null,
  productionAuthorized: true,
  redeployDecision: "pending",
  rollbackAnchorRecorded: false,
  rollbackSupported: false,
  status: "ready",
  ...overrides,
});

describe("emergency shipping state machine", () => {
  test("keeps review before merge and deployment for expedited shipping", () => {
    expect(decideEmergencyShipping(state()).action).toBe("run-focused-checks");
    expect(
      decideEmergencyShipping(state({ focusedChecksPassed: true })).action
    ).toBe("request-independent-review");
    expect(
      decideEmergencyShipping(
        state({
          focusedChecksPassed: true,
          independentReview: "approved",
        })
      ).action
    ).toBe("merge-reviewed-change");
    expect(
      decideEmergencyShipping(
        state({
          focusedChecksPassed: true,
          independentReview: "approved",
          mergeCompleted: true,
        })
      ).action
    ).toBe("deploy-candidate");
  });

  test("requires explicit break-glass authority and rollback capability", () => {
    const breakGlass = state({
      evidence: ["active-user-impact"],
      mode: "break-glass",
      rollbackSupported: true,
    });
    expect(decideEmergencyShipping(breakGlass).action).toBe(
      "request-break-glass-approval"
    );
    expect(
      decideEmergencyShipping({
        ...breakGlass,
        authoritySource: "confirmed-run-only",
        breakGlassAuthorized: true,
      }).action
    ).toBe("deploy-candidate");
  });

  test("deploys before review only in authorized break-glass mode", () => {
    const breakGlass = state({
      authoritySource: "explicit-current-request",
      breakGlassAuthorized: true,
      evidence: ["deploy-before-review"],
      focusedChecksPassed: false,
      mode: "break-glass",
      previousProductionRevision: "9".repeat(40),
      rollbackAnchorRecorded: false,
      rollbackSupported: true,
    });
    expect(decideEmergencyShipping(breakGlass)).toMatchObject({
      action: "deploy-candidate",
      reason:
        "Deploy the exact candidate under explicit break-glass authority.",
    });
    const live = {
      ...breakGlass,
      candidateVerifiedHealthy: true,
      deployedArtifactId: "artifact-a",
      deployedRevision: revisionA,
    };
    expect(deriveEmergencyShippingStatus(live)).toBe("live-unreviewed");
    expect(decideEmergencyShipping(live).action).toBe("run-focused-checks");
    live.focusedChecksPassed = true;
    expect(decideEmergencyShipping(live).action).toBe(
      "request-independent-review"
    );
  });

  test("routes rejected live work to rollback or correction", () => {
    expect(
      decideEmergencyShipping(
        state({
          authoritySource: "explicit-current-request",
          breakGlassAuthorized: true,
          candidateVerifiedHealthy: true,
          deployedArtifactId: "artifact-a",
          deployedRevision: revisionA,
          evidence: ["deploy-before-review"],
          focusedChecksPassed: true,
          independentReview: "changes-requested",
          mode: "break-glass",
          rollbackAnchorRecorded: true,
          rollbackSupported: true,
        })
      )
    ).toMatchObject({
      action: "rollback-or-correct",
      status: "rollback-required",
    });
  });

  test("prioritizes live rejection over stale authority and verification flags", () => {
    expect(
      decideEmergencyShipping(
        state({
          breakGlassAuthorized: false,
          candidateVerifiedHealthy: false,
          deployedRevision: revisionA,
          independentReview: "changes-requested",
          mode: "break-glass",
          productionAuthorized: false,
        })
      )
    ).toMatchObject({
      action: "rollback-or-correct",
      status: "rollback-required",
    });
  });

  test("does not derive completion from cleanup flags without delivery evidence", () => {
    const contradictory = state({
      cleanupCompleted: true,
      finalVerificationPassed: true,
      status: "ready",
    });
    expect(deriveEmergencyShippingStatus(contradictory)).toBe("ready");
    expect(decideEmergencyShipping(contradictory).status).not.toBe("complete");
  });

  test("avoids redeploy only for the same canonical revision or proven artifact", () => {
    const reconciled = state({
      candidateVerifiedHealthy: true,
      canonicalArtifactId: "artifact-a",
      canonicalRevision: revisionB,
      changelogReconciled: true,
      deployedArtifactId: "artifact-a",
      deployedRevision: revisionA,
      focusedChecksPassed: true,
      independentReview: "approved",
      mergeCompleted: true,
    });
    expect(decideEmergencyShipping(reconciled)).toMatchObject({
      action: "deploy-canonical",
      redeployDecision: "deploy-canonical",
      redeployRequired: true,
    });
    expect(
      decideEmergencyShipping({
        ...reconciled,
        artifactEquivalenceProven: true,
      })
    ).toMatchObject({
      action: "verify-equivalent-artifact",
      redeployDecision: "verify-equivalent-artifact",
      redeployRequired: false,
    });
    expect(
      decideEmergencyShipping({
        ...reconciled,
        canonicalRevision: revisionA,
      })
    ).toMatchObject({
      action: "verify-existing-production",
      redeployDecision: "not-required",
      redeployRequired: false,
    });
  });

  test("cannot complete until final verification and cleanup are done", () => {
    const canonical = state({
      candidateVerifiedHealthy: true,
      canonicalArtifactId: "artifact-b",
      canonicalRevision: revisionB,
      changelogReconciled: true,
      deployedArtifactId: "artifact-b",
      deployedRevision: revisionB,
      finalVerificationPassed: true,
      focusedChecksPassed: true,
      independentReview: "approved",
      mergeCompleted: true,
      redeployDecision: "not-required",
    });
    expect(decideEmergencyShipping(canonical).action).toBe("complete-cleanup");
    expect(
      decideEmergencyShipping({ ...canonical, cleanupCompleted: true })
    ).toMatchObject({ action: "complete", status: "complete" });
  });
});
