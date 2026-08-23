#!/usr/bin/env bun

import { type Dirent, existsSync } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const ignoredDirectories = new Set([
  ".git",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);
const installRoots = [
  [".agents", "skills"],
  [".codex", "skills"],
  [".claude", "skills"],
  [".cursor", "skills"],
] as const;
const GIT_SUFFIX_PATTERN = /\.git$/u;
const SCP_SOURCE_PATTERN = /^[^@/]+@([^:]+):(.+)$/u;
const TRAILING_SLASH_PATTERN = /\/+$/u;

interface LockEntry {
  computedHash?: unknown;
  ref?: unknown;
  skillPath?: unknown;
  source?: unknown;
  sourceType?: unknown;
}

interface LockFile {
  skills?: Record<string, LockEntry>;
}

interface Candidate {
  computedHash?: string;
  installIdentities: Set<string>;
  installPaths: Set<string>;
  lockPath?: string;
  physicalInstallPaths: Set<string>;
  ref?: string;
  repositoryRoot: string;
  skill: string;
  skillPath?: string;
  source: string;
  sourceType?: string;
  symlinkPaths: Set<string>;
}

interface Consumer {
  computedHash?: string;
  installationCount: number;
  installPaths: string[];
  lockPath?: string;
  physicalInstallPaths: string[];
  ref?: string;
  repositoryRoot: string;
  resolvedInstallPaths: string[];
  skill: string;
  skillPath?: string;
  source: string;
  sourceType?: string;
  state: "installed" | "lock-only" | "multiple-installs" | "unlocked-install";
  symlinkPaths: string[];
}

interface Options {
  json: boolean;
  maxDepth: number;
  roots: string[];
  skills: Set<string>;
  source: string;
}

const usage = (): never => {
  process.stderr.write(
    [
      "usage: discover-local-consumers.ts --source <owner/repository>",
      "  [--skill <name>]... [--root <directory>]... [--max-depth <n>] [--json]",
      "",
    ].join("\n")
  );
  process.exit(2);
};

const parseOptions = (): Options => {
  const roots: string[] = [];
  const skills = new Set<string>();
  let json = false;
  let maxDepth = 4;
  let source = "";

  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    const value = process.argv[index + 1];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--source" && value) {
      source = value;
      index += 1;
      continue;
    }
    if (argument === "--skill" && value) {
      skills.add(value);
      index += 1;
      continue;
    }
    if (argument === "--root" && value) {
      roots.push(resolve(value));
      index += 1;
      continue;
    }
    if (argument === "--max-depth" && value) {
      maxDepth = Number.parseInt(value, 10);
      index += 1;
      continue;
    }
    usage();
  }

  if (!(source && Number.isInteger(maxDepth) && maxDepth >= 1)) {
    usage();
  }
  if (roots.length === 0) {
    roots.push(resolve(process.cwd(), ".."));
  }
  return { json, maxDepth, roots, skills, source };
};

const compareText = (left: string, right: string): number =>
  left.localeCompare(right, "en");

const walk = async (
  root: string,
  visit: (path: string, directory: boolean) => Promise<void> | void,
  directory = root,
  depth = 0,
  maxDepth = 4
): Promise<void> => {
  if (depth > maxDepth) {
    return;
  }
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => compareText(left.name, right.name));
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      await visit(path, entry.isDirectory());
      if (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        !ignoredDirectories.has(entry.name)
      ) {
        await walk(root, visit, path, depth + 1, maxDepth);
      }
    })
  );
};

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const normalizeSource = (value: unknown): string | undefined => {
  const source = stringValue(value)?.trim().replace(TRAILING_SLASH_PATTERN, "");
  if (!source) {
    return;
  }
  const scpMatch = SCP_SOURCE_PATTERN.exec(source);
  if (scpMatch?.[1] && scpMatch[2]) {
    return `${scpMatch[1]}/${scpMatch[2]}`
      .replace(GIT_SUFFIX_PATTERN, "")
      .toLowerCase();
  }
  try {
    const url = new URL(source);
    return `${url.hostname}${url.pathname}`
      .replace(TRAILING_SLASH_PATTERN, "")
      .replace(GIT_SUFFIX_PATTERN, "")
      .toLowerCase();
  } catch {
    return source.replace(GIT_SUFFIX_PATTERN, "").toLowerCase();
  }
};

const sourcesMatch = (left: unknown, right: unknown): boolean => {
  const normalizedLeft = normalizeSource(left);
  const normalizedRight = normalizeSource(right);
  if (!(normalizedLeft && normalizedRight)) {
    return false;
  }
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`)
  );
};

const keyFor = (repositoryRoot: string, skill: string): string =>
  `${repositoryRoot}\u0000${skill}`;

const recordInstallPath = async (
  candidate: Candidate,
  installPath: string
): Promise<void> => {
  candidate.installPaths.add(installPath);
  if ((await lstat(installPath)).isSymbolicLink()) {
    candidate.symlinkPaths.add(installPath);
  } else {
    candidate.physicalInstallPaths.add(installPath);
  }
  candidate.installIdentities.add(await realpath(installPath));
};

const options = parseOptions();
const candidates = new Map<string, Candidate>();
const diagnostics: string[] = [];
const lockedSources = new Map<string, string | undefined>();
const globalSearchRoots = installRoots.map((segments) =>
  join(homedir(), ...segments)
);

const collectLockCandidates = async (path: string): Promise<void> => {
  let lock: LockFile;
  try {
    lock = JSON.parse(await readFile(path, "utf8")) as LockFile;
  } catch (error) {
    diagnostics.push(
      `Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }
  const repositoryRoot = dirname(path);
  await Promise.all(
    Object.entries(lock.skills ?? {}).map(async ([skill, entry]) => {
      const key = keyFor(repositoryRoot, skill);
      lockedSources.set(key, stringValue(entry.source));
      if (
        !sourcesMatch(entry.source, options.source) ||
        (options.skills.size > 0 && !options.skills.has(skill))
      ) {
        return;
      }
      const candidate =
        candidates.get(key) ??
        ({
          installIdentities: new Set<string>(),
          installPaths: new Set<string>(),
          physicalInstallPaths: new Set<string>(),
          repositoryRoot,
          skill,
          source: stringValue(entry.source) ?? options.source,
          symlinkPaths: new Set<string>(),
        } satisfies Candidate);
      candidate.lockPath = path;
      candidate.computedHash = stringValue(entry.computedHash);
      candidate.ref = stringValue(entry.ref);
      candidate.skillPath = stringValue(entry.skillPath);
      candidate.sourceType = stringValue(entry.sourceType);
      await Promise.all(
        installRoots.map(async (segments) => {
          const installPath = join(repositoryRoot, ...segments, skill);
          if (existsSync(join(installPath, "SKILL.md"))) {
            await recordInstallPath(candidate, installPath);
          }
        })
      );
      candidates.set(key, candidate);
    })
  );
};

const collectInstalledCandidate = async (path: string): Promise<void> => {
  const skill = basename(path);
  if (!(options.skills.has(skill) && existsSync(join(path, "SKILL.md")))) {
    return;
  }
  const skillsDirectory = dirname(path);
  const agentDirectory = dirname(skillsDirectory);
  const owner = basename(agentDirectory);
  if (
    basename(skillsDirectory) !== "skills" ||
    ![".agents", ".codex", ".claude", ".cursor"].includes(owner)
  ) {
    return;
  }
  const repositoryRoot = dirname(agentDirectory);
  const key = keyFor(repositoryRoot, skill);
  const lockedSource = lockedSources.get(key);
  if (lockedSource && !sourcesMatch(lockedSource, options.source)) {
    return;
  }
  const candidate =
    candidates.get(key) ??
    ({
      installIdentities: new Set<string>(),
      installPaths: new Set<string>(),
      physicalInstallPaths: new Set<string>(),
      repositoryRoot,
      skill,
      source: options.source,
      symlinkPaths: new Set<string>(),
    } satisfies Candidate);
  await recordInstallPath(candidate, path);
  candidates.set(key, candidate);
};

await Promise.all(
  options.roots.map((root) =>
    walk(
      root,
      async (path, directory) => {
        if (directory || basename(path) !== "skills-lock.json") {
          return;
        }
        await collectLockCandidates(path);
      },
      root,
      0,
      options.maxDepth
    )
  )
);

if (options.skills.size > 0) {
  await Promise.all(
    options.roots.map((root) =>
      walk(
        root,
        async (path, directory) => {
          if (!directory) {
            return;
          }
          await collectInstalledCandidate(path);
        },
        root,
        0,
        options.maxDepth
      )
    )
  );
  await globalSearchRoots
    .flatMap((root) => [...options.skills].map((skill) => join(root, skill)))
    .reduce(
      (previous, path) => previous.then(() => collectInstalledCandidate(path)),
      Promise.resolve()
    );
}

const consumers: Consumer[] = [...candidates.values()]
  .map((candidate) => {
    const installPaths = [...candidate.installPaths].sort(compareText);
    const physicalInstallPaths = [...candidate.physicalInstallPaths].sort(
      compareText
    );
    const symlinkPaths = [...candidate.symlinkPaths].sort(compareText);
    const installationCount = candidate.installIdentities.size;
    const resolvedInstallPaths = [...candidate.installIdentities].sort(
      compareText
    );
    let state: Consumer["state"] = "lock-only";
    if (!candidate.lockPath) {
      state = "unlocked-install";
    } else if (installationCount > 1) {
      state = "multiple-installs";
    } else if (installationCount === 1) {
      state = "installed";
    }
    return {
      ...(candidate.computedHash
        ? { computedHash: candidate.computedHash }
        : {}),
      installationCount,
      installPaths,
      ...(candidate.lockPath ? { lockPath: candidate.lockPath } : {}),
      physicalInstallPaths,
      ...(candidate.ref ? { ref: candidate.ref } : {}),
      repositoryRoot: candidate.repositoryRoot,
      resolvedInstallPaths,
      skill: candidate.skill,
      ...(candidate.skillPath ? { skillPath: candidate.skillPath } : {}),
      source: candidate.source,
      ...(candidate.sourceType ? { sourceType: candidate.sourceType } : {}),
      state,
      symlinkPaths,
    };
  })
  .sort((left, right) => {
    const byRepository = compareText(left.repositoryRoot, right.repositoryRoot);
    return byRepository || compareText(left.skill, right.skill);
  });

if (options.json) {
  process.stdout.write(
    `${JSON.stringify(
      {
        consumers,
        diagnostics,
        globalSearchRoots,
        searchRoots: options.roots,
        skills: [...options.skills].sort(compareText),
        source: options.source,
      },
      null,
      2
    )}\n`
  );
} else {
  for (const consumer of consumers) {
    process.stdout.write(
      `${consumer.state}\t${consumer.skill}\t${consumer.repositoryRoot}\t${
        consumer.installPaths.join(",") || "-"
      }\n`
    );
  }
  for (const diagnostic of diagnostics) {
    process.stderr.write(`${diagnostic}\n`);
  }
}

if (diagnostics.length > 0) {
  process.exitCode = 1;
}
