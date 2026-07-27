#!/usr/bin/env bun

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const skillRoot = resolve(import.meta.dir, "../../../../skills/publish-skill");

const readPackageFile = (path: string): Promise<string> =>
  readFile(resolve(skillRoot, path), "utf8");

const [skill, releaseMap, productionLoop, mergeVerification, agentMetadata] =
  await Promise.all([
    readPackageFile("SKILL.md"),
    readPackageFile("references/release-map.md"),
    readPackageFile("references/production-loop.md"),
    readPackageFile("references/merge-verification.md"),
    readPackageFile("agents/openai.yaml"),
  ]);

describe("publish-skill package design", () => {
  test("defines the shared all-consumer publication lifecycle", () => {
    expect(skill).toContain("every local consumer");
    expect(skill).toContain("discover-local-consumers.ts");
    expect(skill).toContain("bounded parallelism");
    expect(skill).toContain("one failure must not cancel");

    for (const retentionMode of [
      "maintained",
      "validation-only",
      "intentional",
      "stale",
    ]) {
      expect(skill).toContain(retentionMode);
    }
  });

  test("covers every supported consumer state and install root", () => {
    for (const state of [
      "installed",
      "multiple-installs",
      "lock-only",
      "unlocked-install",
    ]) {
      expect(releaseMap).toContain(`\`${state}\``);
    }

    for (const installRoot of [
      ".agents/skills",
      ".claude/skills",
      ".cursor/skills",
    ]) {
      expect(releaseMap).toContain(`\`${installRoot}\``);
    }

    expect(releaseMap).toContain("global skill roots");
  });

  test("requires isolated, concurrent, all-settled validation", () => {
    expect(productionLoop).toContain("isolated");
    expect(productionLoop).toContain("concurrently with bounded parallelism");
    expect(productionLoop).toContain("wait for all consumers to finish");
    expect(productionLoop).toContain("one failure must not cancel");
  });

  test("treats active external work as owned, never stale", () => {
    expect(skill).toContain("externally-owned");
    expect(skill).toContain("do not transfer ownership");
    expect(skill).toContain("explicit handoff");
    expect(skill).toContain("Repeat the ownership check immediately");
    expect(skill).toContain("outstanding-work ledger");

    expect(releaseMap).toContain("Classify Ownership Before Scope");
    expect(releaseMap).toContain("An active worktree");
    expect(releaseMap).toContain("Proven stale");
    expect(releaseMap).toContain("Repeat this classification immediately");

    expect(productionLoop).toContain("Ownership Gate");
    expect(productionLoop).toContain("Do not delegate the takeover");
    expect(productionLoop).toContain("create an independent worktree");

    expect(mergeVerification).toContain("is not stale");
    expect(mergeVerification).toContain(
      "explicit handoff naming that exact work"
    );
  });

  test("advertises the same scope in agent metadata", () => {
    expect(agentMetadata).toContain("every maintained fork");
    expect(agentMetadata).toContain("discovered local consumer");
    expect(agentMetadata).toContain("externally-owned active work");
  });
});
