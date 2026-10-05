import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  completedRemovalProofForPath,
  frozenRecoveryBlockingViolations,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import type {
  LoopLease,
  LoopVerification,
} from "../../../skills/simple-changes/scripts/lib/types.ts";

// Adapted from the Site Secure fork, which carried these recovery rules as a
// runtime delta before they moved upstream.

const verification = (
  ...violations: LoopVerification["violations"]
): LoopVerification => ({
  active: true,
  checkedAt: "2026-09-03T00:00:00.000Z",
  currentBaselineDigest: "digest",
  ok: violations.length === 0,
  runId: "run-test",
  violations,
});

const violation = (
  code: LoopVerification["violations"][number]["code"],
  path: string
): LoopVerification["violations"][number] => ({
  changeDigest: null,
  code,
  headSha: null,
  message: code,
  path,
});

const lease = {
  preparations: [],
  shipmentScopeFrozenAt: "2026-09-02T00:00:00.000Z",
  worktrees: [
    {
      agentId: null,
      createdByRun: false,
      path: "/preserved",
      role: "preserved",
    },
    {
      agentId: null,
      createdByRun: false,
      path: "/retained",
      role: "retained",
    },
    { agentId: null, createdByRun: false, path: "/author", role: "author" },
    {
      agentId: null,
      createdByRun: true,
      path: "/created",
      role: "preserved",
    },
  ],
} as unknown as LoopLease;

describe("frozenRecoveryBlockingViolations", () => {
  test("ignores only unrelated preserved and retained checkout violations", () => {
    const result = frozenRecoveryBlockingViolations(
      lease,
      verification(
        violation("missing-preserved-worktree", "/preserved"),
        violation("missing-retained-worktree", "/retained"),
        violation("preserved-worktree-changed", "/preserved")
      )
    );

    expect(result).toEqual([]);
  });

  test("keeps shipment obligations and unregistered work blocking", () => {
    const result = frozenRecoveryBlockingViolations(
      lease,
      verification(
        violation("preserved-worktree-changed", "/author"),
        violation("missing-preserved-worktree", "/created"),
        violation("unregistered-worktree", "/late")
      )
    );

    expect(result.map(({ path }) => path)).toEqual([
      "/author",
      "/created",
      "/late",
    ]);
  });

  test("keeps authorization and coordination violations blocking", () => {
    const result = frozenRecoveryBlockingViolations(
      lease,
      verification(
        violation("retained-worktree-authorization-missing", "/retained"),
        violation("coordination-claim-stale", "/preserved")
      )
    );

    expect(result.map(({ code }) => code)).toEqual([
      "retained-worktree-authorization-missing",
      "coordination-claim-stale",
    ]);
  });

  test("keeps a missing adopted preserved checkout blocking", () => {
    const adoptedLease = {
      ...lease,
      worktrees: [
        ...lease.worktrees,
        {
          agentId: "other-agent",
          claimId: "claim-1",
          coordinationState: "adopted-preserved",
          createdByRun: false,
          path: "/adopted",
          pauseReceiptId: "pause-1",
          role: "preserved",
        },
      ],
    } as unknown as LoopLease;
    const item = violation("missing-preserved-worktree", "/adopted");

    expect(
      frozenRecoveryBlockingViolations(adoptedLease, verification(item))
    ).toEqual([item]);
  });

  test.each([
    "preserved-worktree-changed",
    "missing-preserved-worktree",
  ] as const)("keeps scoped preserved sources blocking: %s", (code) => {
    const scopedLease = {
      ...lease,
      shipmentScope: { plan: { units: [{ sourceWorktree: "/preserved" }] } },
    } as unknown as LoopLease;
    const item = violation(code, "/preserved");
    expect(
      frozenRecoveryBlockingViolations(scopedLease, verification(item))
    ).toEqual([item]);
  });

  test("keeps the preserved primary checkout blocking", () => {
    const primaryLease = {
      ...lease,
      primaryCheckout: "/preserved",
    } as unknown as LoopLease;
    const item = violation("preserved-worktree-changed", "/preserved");

    expect(
      frozenRecoveryBlockingViolations(primaryLease, verification(item))
    ).toEqual([item]);
  });

  test("keeps every violation blocking before scope freezes", () => {
    const activeLease = {
      ...lease,
      shipmentScopeFrozenAt: null,
    } as unknown as LoopLease;
    const item = violation("missing-preserved-worktree", "/preserved");

    expect(
      frozenRecoveryBlockingViolations(activeLease, verification(item))
    ).toEqual([item]);
  });
});

describe("completedRemovalProofForPath", () => {
  test("treats a dangling symlink at the removed path as present", () => {
    const base = mkdtempSync(join(tmpdir(), "dangling-"));
    const link = join(base, "removed");
    try {
      symlinkSync(join(base, "missing-target"), link);
      const candidate = structuredClone(removalLease);
      const disposition = candidate.dispositions?.[0];
      if (!disposition) {
        throw new Error("Missing fixture disposition");
      }
      disposition.path = link;
      expect(
        completedRemovalProofForPath(
          candidate,
          link,
          "refreshed-target",
          () => true
        )
      ).toBeNull();
    } finally {
      rmSync(base, { force: true, recursive: true });
    }
  });

  test("rejects removal evidence while the path exists on disk again", () => {
    const recreated = mkdtempSync(join(tmpdir(), "recreated-"));
    try {
      const candidate = structuredClone(removalLease);
      const disposition = candidate.dispositions?.[0];
      if (!disposition) {
        throw new Error("Missing fixture disposition");
      }
      disposition.path = recreated;
      expect(
        completedRemovalProofForPath(
          candidate,
          recreated,
          "refreshed-target",
          () => true
        )
      ).toBeNull();
    } finally {
      rmSync(recreated, { force: true, recursive: true });
    }
  });

  const removalLease = {
    dispositions: [
      {
        headSha: "removed-head",
        outcome: "remove-after-audit",
        path: "/removed",
        status: "completed",
        targetRef: "gitlab/main",
        targetRevision: "audited-target",
      },
    ],
    primaryCheckout: "/repo",
    targetRef: "gitlab/main",
  } as unknown as LoopLease;

  test("accepts completed removal evidence contained by the refreshed target", () => {
    const contains = (_repo: string, target: string, revision: string) =>
      target === "refreshed-target" &&
      ["audited-target", "removed-head"].includes(revision);

    expect(
      completedRemovalProofForPath(
        removalLease,
        "/removed",
        "refreshed-target",
        contains
      )
    ).toEqual({
      headSha: "removed-head",
      method: "target-ancestry",
      path: "/removed",
    });
  });

  test.each(["intended", undefined])(
    "rejects incomplete removal status %s",
    (status) => {
      const candidate = structuredClone(removalLease);
      const disposition = candidate.dispositions?.[0];
      if (!disposition) {
        throw new Error("Missing fixture disposition");
      }
      if (status === undefined) {
        Reflect.deleteProperty(disposition, "status");
      } else {
        disposition.status = status;
      }
      expect(
        completedRemovalProofForPath(
          candidate,
          "/removed",
          "refreshed-target",
          () => true
        )
      ).toBeNull();
    }
  );

  test.each(["audited-target", "removed-head"])(
    "rejects evidence when %s is not contained",
    (missingRevision) => {
      const contains = (_repo: string, _target: string, revision: string) =>
        revision !== missingRevision;

      expect(
        completedRemovalProofForPath(
          removalLease,
          "/removed",
          "refreshed-target",
          contains
        )
      ).toBeNull();
    }
  );
});
