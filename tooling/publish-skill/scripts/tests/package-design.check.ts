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
    expect(skill).toContain("bounded");
    expect(skill).toContain("parallelism");
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
      ".codex/skills",
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

  test("updates every symlink target while preserving the link", () => {
    expect(skill).toContain("For every discovered");
    expect(skill).toContain("symlink, resolve it, update its real target");
    expect(skill).toContain("leave the symlink in place");
    expect(productionLoop).toContain("resolvedInstallPaths");
    expect(productionLoop).toContain("Update that real");
    expect(productionLoop).toContain("leave every symlink in place");
  });

  test("distinguishes dirty baseline state from newly active external work", () => {
    expect(skill).toContain("externally-owned");
    expect(skill).toContain("do not transfer ownership");
    expect(skill).toContain("explicit handoff");
    expect(skill).toContain("Repeat the ownership check immediately");
    expect(skill).toContain("outstanding-work ledger");
    expect(skill).toContain("not by itself active");
    expect(skill).toContain("do not classify the repository");

    expect(releaseMap).toContain("Classify Ownership Before Scope");
    expect(releaseMap).toContain("Preserved baseline");
    expect(releaseMap).toContain("Externally-owned active");
    expect(releaseMap).toContain("Active ownership requires");
    expect(releaseMap).toContain("continue the loop");
    expect(releaseMap).toContain("Proven stale");
    expect(releaseMap).toContain("Repeat this classification immediately");

    expect(productionLoop).toContain("Ownership Gate");
    expect(productionLoop).toContain("Do not delegate the takeover");
    expect(productionLoop).toContain("independent remote-default worktree");
    expect(productionLoop).toContain(
      "Static dirty state found at the first observation does not trigger"
    );

    expect(mergeVerification).toContain("is not stale");
    expect(mergeVerification).toContain("baseline existence alone is also not");
    expect(mergeVerification).toContain(
      "informational rather than outstanding"
    );
  });

  test("advertises the same scope in agent metadata", () => {
    expect(agentMetadata).toContain("every maintained fork");
    expect(agentMetadata).toContain("discovered local consumer");
    expect(agentMetadata).toContain("Preserve dirty baseline checkouts");
    expect(agentMetadata).toContain("newly observed active external work");
  });
});
