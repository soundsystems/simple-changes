import { describe, expect, test } from "bun:test";
import {
  type PrimaryDeliveryProofInput,
  primaryDeliveryProof,
} from "../../../skills/simple-changes/scripts/lib/primary-delivery-proof.ts";

const fixture = (): PrimaryDeliveryProofInput & {
  changes: { conflicted: boolean; originalPath: string | null; path: string }[];
  delivered: Map<string, string | null>;
} => ({
  baselineBranch: "main",
  baselineDigest: "unchanged",
  baselineHead: "base",
  branch: "main",
  changes: [
    { conflicted: false, originalPath: null, path: "web.ts" },
    { conflicted: false, originalPath: null, path: "mobile.ts" },
  ],
  delivered: new Map<string, string | null>([["web.ts", "reviewed"]]),
  digest: "unchanged",
  excluded: ["mobile.ts"],
  head: "base",
  headContained: true,
  headEntry: () => "old",
  isPrimary: true,
  outcomeTarget: "target",
  preserved: [],
  scoped: ["web.ts"],
  sourceEntry: () => "original",
  target: "target",
  targetEntry: () => "reviewed",
});

describe("primary delivery proof", () => {
  test("accepts a review-changed scoped path delivered to the target plus an unchanged exclusion", () => {
    expect(primaryDeliveryProof(fixture())).toBe(true);
  });

  test("rejects changed primary contents via the baseline digest", () => {
    expect(primaryDeliveryProof({ ...fixture(), digest: "changed" })).toBe(
      false
    );
  });

  test("requires a contained primary HEAD whenever scoped paths exist", () => {
    expect(primaryDeliveryProof({ ...fixture(), headContained: false })).toBe(
      false
    );
    expect(
      primaryDeliveryProof({
        ...fixture(),
        changes: fixture().changes.slice(1),
        delivered: new Map(),
        headContained: false,
        scoped: [],
      })
    ).toBe(true);
  });

  test("rejects new unclassified dirty paths", () => {
    const value = fixture();
    value.changes.push({
      conflicted: false,
      originalPath: null,
      path: "other.ts",
    });
    expect(primaryDeliveryProof(value)).toBe(false);
  });

  test("checks every scoped path, including paths absent from dirty status", () => {
    expect(
      primaryDeliveryProof({ ...fixture(), scoped: ["web.ts", "missing.ts"] })
    ).toBe(false);
  });

  test("rejects a target entry that drifted from the receipt and a stale outcome target", () => {
    expect(
      primaryDeliveryProof({ ...fixture(), targetEntry: () => "different" })
    ).toBe(false);
    expect(primaryDeliveryProof({ ...fixture(), outcomeTarget: "old" })).toBe(
      false
    );
    expect(
      primaryDeliveryProof({ ...fixture(), outcomeTarget: undefined })
    ).toBe(false);
  });

  test("requires rename originals to be accounted for", () => {
    const value = fixture();
    const [first] = value.changes;
    if (first) {
      first.originalPath = "old.ts";
    }
    expect(primaryDeliveryProof(value)).toBe(false);
    value.delivered.set("old.ts", null);
    expect(
      primaryDeliveryProof({
        ...value,
        targetEntry: (path) => (path === "old.ts" ? null : "reviewed"),
      })
    ).toBe(true);
  });

  test("never relaxes non-primary, branch, head, or conflict safety", () => {
    expect(primaryDeliveryProof({ ...fixture(), isPrimary: false })).toBe(
      false
    );
    expect(primaryDeliveryProof({ ...fixture(), branch: "other" })).toBe(false);
    expect(primaryDeliveryProof({ ...fixture(), head: "other" })).toBe(false);
    expect(primaryDeliveryProof({ ...fixture(), head: "target" })).toBe(true);
    const value = fixture();
    const [first] = value.changes;
    if (first) {
      first.conflicted = true;
    }
    expect(primaryDeliveryProof(value)).toBe(false);
  });

  test("a scoped path deleted by review must be absent from the target", () => {
    const value = fixture();
    value.delivered.set("web.ts", null);
    expect(primaryDeliveryProof({ ...value, targetEntry: () => null })).toBe(
      true
    );
    expect(primaryDeliveryProof(value)).toBe(false);
  });

  test("accepts an already-clean scoped path only as contained HEAD content", () => {
    const value = {
      ...fixture(),
      changes: fixture().changes.slice(1),
      sourceEntry: () => "old",
    };
    expect(primaryDeliveryProof(value)).toBe(true);
    expect(
      primaryDeliveryProof({ ...value, sourceEntry: () => "edited" })
    ).toBe(false);
    expect(primaryDeliveryProof({ ...value, headContained: false })).toBe(
      false
    );
  });
});
