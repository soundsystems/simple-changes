import { describe, expect, test } from "bun:test";
import {
  buildPermissionBundle,
  renderPermissionBundle,
} from "../../../skills/simple-changes/scripts/lib/permission-bundle.ts";

describe("shipping permission bundles", () => {
  test("collects every known exact-target decision into one deterministic prompt", () => {
    const generatedAt = "2026-08-13T20:00:00.000Z";
    const bundle = buildPermissionBundle(
      [
        {
          authority: "production-deploy",
          consequence: "Makes the reviewed revision live for customers.",
          operation: "deploy-production",
          reason: "Ship includes production verification.",
          target: "Vercel project simple-changes / production",
        },
        {
          authority: "proposal-write",
          consequence: "Exports the reviewed commits to the remote.",
          operation: "push",
          reason: "A proposal cannot open until its branch exists remotely.",
          target: "origin https://github.com/example/simple-changes.git",
        },
      ],
      generatedAt
    );

    expect(bundle.requests).toHaveLength(2);
    expect(buildPermissionBundle(bundle.requests, generatedAt)).toEqual(bundle);
    const prompt = renderPermissionBundle(bundle);
    expect(prompt).toContain("every currently known permission in one reply");
    expect(prompt).toContain("deploy-production");
    expect(prompt).toContain("push");
    expect(prompt).toContain("Unlisted future actions are not authorized");
  });

  test("deduplicates exact requests and rejects vague targets", () => {
    const request = {
      authority: "merge" as const,
      consequence: "Adds the approved head to canonical main.",
      operation: "merge" as const,
      reason: "The reviewed proposal is ready.",
      target: "GitLab project group/repo MR !42 at abc123",
    };
    expect(buildPermissionBundle([request, request]).requests).toHaveLength(1);
    expect(() => buildPermissionBundle([{ ...request, target: " " }])).toThrow(
      "target must be explicit"
    );
    expect(() =>
      buildPermissionBundle([{ ...request, authority: "proposal-write" }])
    ).toThrow("requires authority merge");
  });
});
