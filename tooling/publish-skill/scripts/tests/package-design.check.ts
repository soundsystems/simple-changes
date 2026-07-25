#!/usr/bin/env bun

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const skillRoot = resolve(import.meta.dir, "../../../../skills/publish-skill");

const readPackageFile = (path: string): Promise<string> =>
  readFile(resolve(skillRoot, path), "utf8");

const [skill, releaseMap, productionLoop, agentMetadata] = await Promise.all([
  readPackageFile("SKILL.md"),
  readPackageFile("references/release-map.md"),
  readPackageFile("references/production-loop.md"),
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

  test("advertises the same scope in agent metadata", () => {
    expect(agentMetadata).toContain("every maintained fork");
    expect(agentMetadata).toContain("discovered local consumer");
  });
});
