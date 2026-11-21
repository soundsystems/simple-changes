import { randomUUID } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { completeConfigListing, completeLine } from "./git-complete.ts";
import { ensureStateDirectory, gitReportedPath } from "./git-location.ts";
import { isLossyName } from "./inventory.ts";
import { runGit } from "./process.ts";
import { validateSchema } from "./schema.ts";
import type { LoopLease, RepositoryInventory } from "./types.ts";

/**
 * The target a Queue or Sweep run proposed into, as it stood when the run
 * closed: one branch on one remote. A later clean-up asks exactly this
 * remote about exactly this ref, whatever target a later run selects.
 */
export interface QueuedTargetBinding {
  /** The target's full ref on the remote, `refs/heads/<branch>`. */
  ref: string;
  /** The remote's name when the run closed; the address is what binds. */
  remote: string;
  /**
   * The remote's one fetch address as Git resolved it, in the form
   * `safeTargetAddress` accepts: never with a credential.
   */
  url: string;
}

/** Where a kept worktree went when a later start moved it to the Trash. */
export interface TrashedQueuedWorktree {
  /** When it was moved. */
  at: string;
  /**
   * The worktree's private Git directory as it was,
   * `<common>/worktrees/<name>`: where that directory belongs again if the
   * folder is put back.
   */
  gitDirectory: string;
  /** The commit the worktree was on. Its branch was kept. */
  headSha: string;
  /**
   * Where the folder is now, confirmed to be the same folder, or null when
   * its new place could not be confirmed.
   */
  location: string | null;
  /**
   * `moved-with-copy`: the private Git directory is inside the moved
   * folder, so Git no longer lists the worktree. `left-in-git`: it is
   * still where it was, and Git lists a worktree whose folder is missing.
   */
  registration: "left-in-git" | "moved-with-copy";
}

/** One worktree a closed Queue or Sweep run created and kept. */
export interface KeptQueuedWorktree {
  branch: string;
  path: string;
  /**
   * The ID `prepare-agent` wrote into this worktree's private Git directory
   * when the run registered it. A checkout made again at the same path has
   * a new private directory and so no such ID, and is never this
   * registration.
   */
  registrationId: string;
  target: QueuedTargetBinding;
  /**
   * Set once a later start moved this worktree to the Trash. Such an entry
   * is history: it is never moved again, also not after someone puts the
   * folder back.
   */
  trashed?: TrashedQueuedWorktree;
}

/**
 * The record a closed Queue or Sweep run leaves beside the loop state, in
 * its own file so older runtimes never meet it. A later Queue or Sweep
 * start reads it to know which checkouts it may move to the Trash once
 * their work is in the target, and writes each move back into it; the
 * record proves nothing by itself.
 */
export interface QueuedWorktreesRecord {
  closedAt: string;
  kind: "queued-worktrees";
  mode: "queue" | "sweep";
  runId: string;
  schemaVersion: 1;
  worktrees: KeptQueuedWorktree[];
}

const END_OF_LINE = /\n$/u;
const STATE_DIRECTORY = "simple-changes";
const RECORDS_DIRECTORY = "queued-worktrees";
const REGISTRATION_FILE = "simple-changes-queued-worktree";
const REGISTRATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const REMOTE_REF_PREFIX = "refs/remotes/";

const recordsDirectory = (commonGitDirectory: string): string =>
  resolve(commonGitDirectory, STATE_DIRECTORY, RECORDS_DIRECTORY);

const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | null)?.code;

// `<helper>::<address>`: the address belongs to a program this cannot read.
const TRANSPORT_HELPER_PATTERN = /^[0-9A-Za-z][0-9A-Za-z+.-]*::/u;
const URL_SCHEME_PATTERN = /^([A-Za-z][0-9A-Za-z+.-]*):\/\//u;
const WINDOWS_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/u;
// `[user@]host:path`, with nothing after the colon that could be a second
// user name or a password.
const SCP_LIKE_PATTERN = /^(?:[\w.~-]+@)?[\w.-]+:[^@\s]+$/u;
const UNPRINTABLE_PATTERN = /[\s\p{Cc}]/u;
const WEB_SCHEMES: ReadonlySet<string> = new Set(["http", "https"]);
const SSH_SCHEMES: ReadonlySet<string> = new Set(["ssh", "git+ssh", "ssh+git"]);
const PLAIN_SCHEMES: ReadonlySet<string> = new Set(["file", "git"]);

// A `scheme://` address, or null when it is not one of the forms below.
const safeUrlAddress = (address: string, scheme: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    return null;
  }
  // A query or fragment can carry a token, and names no repository.
  if (parsed.search !== "" || parsed.hash !== "") {
    return null;
  }
  if (WEB_SCHEMES.has(scheme)) {
    if (parsed.username === "" && parsed.password === "") {
      return address;
    }
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  }
  if (parsed.password !== "") {
    return null;
  }
  if (SSH_SCHEMES.has(scheme)) {
    return address;
  }
  return parsed.username === "" && PLAIN_SCHEMES.has(scheme) ? address : null;
};

/**
 * The form of a remote address that may be written to a record and shown
 * in a report, or null when the address cannot be read safely, which
 * leaves its target unbound. Only these forms pass:
 *
 * - `http://` and `https://`, with any user name and password removed:
 *   there they are a credential and never part of which repository it is;
 * - `ssh://` (and `git+ssh://`, `ssh+git://`) and `[user@]host:path`, with
 *   the user name kept, because the same path can name another repository
 *   for another user (`~/repo.git`), and refused with a password;
 * - `git://` and `file://` without a user name, and an absolute path.
 *
 * Everything else is refused: a `<helper>::<address>` form, whose address
 * another program reads; any other scheme; a query or fragment; and a
 * relative path, which Git could read as the name of a configured remote.
 */
export const safeTargetAddress = (address: string): string | null => {
  if (
    address === "" ||
    address.startsWith("-") ||
    isLossyName(address) ||
    UNPRINTABLE_PATTERN.test(address) ||
    TRANSPORT_HELPER_PATTERN.test(address)
  ) {
    return null;
  }
  const scheme = URL_SCHEME_PATTERN.exec(address)?.[1]?.toLowerCase();
  if (scheme) {
    return safeUrlAddress(address, scheme);
  }
  if (address.startsWith("/") || WINDOWS_ABSOLUTE_PATTERN.test(address)) {
    return address;
  }
  return SCP_LIKE_PATTERN.test(address) ? address : null;
};

/**
 * The remote's one fetch address exactly as Git resolved it, or null when
 * it has none, more than one, or one Git would read as an option. This is
 * the address to ask; only its `safeTargetAddress` form is ever recorded.
 */
export const singleFetchUrl = (
  repositoryPath: string,
  remote: string
): string | null => {
  let url: string | null;
  try {
    // One whole line: a remote with several fetch addresses is refused.
    url = completeLine(repositoryPath, [
      "remote",
      "get-url",
      "--all",
      remote,
    ]).line;
  } catch {
    url = null;
  }
  return url && !url.startsWith("-") ? url : null;
};

// The configured remote a remote-tracking ref belongs to, and its branch
// there. A remote's name may hold a slash, so each prefix is asked of Git.
// With remotes `team` and `team/fork`, `refs/remotes/team/fork/main` reads
// two ways, so anything but exactly one match is no answer.
const remoteAndBranch = (
  primaryCheckout: string,
  trackingRef: string
): { branch: string; remote: string } | null => {
  const matches: { branch: string; remote: string }[] = [];
  for (const { key, value } of completeConfigListing(primaryCheckout)) {
    if (!(key.startsWith("remote.") && key.endsWith(".fetch"))) {
      continue;
    }
    const remote = key.slice("remote.".length, -".fetch".length);
    // Decline custom mappings, including exclusions. They can map a
    // different remote or branch into another remote's usual namespace.
    if (value !== `+refs/heads/*:refs/remotes/${remote}/*`) {
      return null;
    }
    const prefix = `${REMOTE_REF_PREFIX}${remote}/`;
    if (trackingRef.startsWith(prefix)) {
      matches.push({ branch: trackingRef.slice(prefix.length), remote });
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
};

/**
 * The remote branch `targetRef` stands for, or why it cannot be bound. A
 * target that is not a branch on exactly one remote, with one fetch
 * address that can be recorded safely, has nothing a later run could ask,
 * so its worktrees are never moved automatically.
 */
export const queuedTargetBinding = (
  primaryCheckout: string,
  targetRef: string
): QueuedTargetBinding | { unbound: string } => {
  let fullRef: string | null;
  try {
    fullRef = completeLine(primaryCheckout, [
      "rev-parse",
      "--symbolic-full-name",
      targetRef,
    ]).line;
  } catch {
    fullRef = null;
  }
  if (!fullRef?.startsWith(REMOTE_REF_PREFIX) || isLossyName(fullRef)) {
    return { unbound: `${targetRef} is not a branch on a remote` };
  }
  let found: { branch: string; remote: string } | null;
  try {
    found = remoteAndBranch(primaryCheckout, fullRef);
  } catch {
    found = null;
  }
  if (!found || found.branch === "HEAD") {
    return {
      unbound: `${targetRef} does not name one branch on exactly one remote`,
    };
  }
  const configured = singleFetchUrl(primaryCheckout, found.remote);
  if (!configured) {
    return {
      unbound: `${found.remote} does not have exactly one address to ask`,
    };
  }
  const url = safeTargetAddress(configured);
  if (!url) {
    return {
      unbound: `the address of ${found.remote} is not in a form that can be recorded safely`,
    };
  }
  return { ref: `refs/heads/${found.branch}`, remote: found.remote, url };
};

/**
 * The private Git directory of a linked worktree, `<common>/worktrees/<id>`,
 * which Git deletes when it removes the worktree. Null when the path is not
 * a linked worktree of this repository or Git cannot say.
 */
export const privateGitDirectory = (
  commonGitDirectory: string,
  worktreePath: string
): string | null => {
  const answer = runGit(
    worktreePath,
    ["rev-parse", "--absolute-git-dir"],
    true
  );
  if (answer.exitCode !== 0) {
    return null;
  }
  try {
    const directory = realpathSync(
      gitReportedPath(answer.stdout, "--absolute-git-dir", {
        repository: worktreePath,
      })
    );
    const marker = join(worktreePath, ".git");
    const backlink = readFileSync(join(directory, "gitdir"), "utf8").replace(
      END_OF_LINE,
      ""
    );
    if (
      realpathSync(worktreePath) !== worktreePath ||
      !lstatSync(marker).isFile() ||
      realpathSync(resolve(directory, backlink)) !== marker
    ) {
      return null;
    }
    return dirname(directory) ===
      join(realpathSync(commonGitDirectory), "worktrees")
      ? directory
      : null;
  } catch {
    return null;
  }
};

/**
 * The registration ID in a worktree's private Git directory, or null when
 * none was ever written there. A file that cannot be read throws, so an
 * unknown answer never reads as "no ID".
 */
const folderStamp = (path: string): string => {
  const folder = lstatSync(path, { bigint: true });
  return `${folder.dev}:${folder.ino}:${folder.birthtimeNs}`;
};

export const readRegistrationId = (
  gitDirectory: string,
  path: string,
  runId?: string
): string | null => {
  let text: string;
  try {
    const stamp = readFileSync(
      join(gitDirectory, `${REGISTRATION_FILE}.folder`),
      "utf8"
    );
    const [identity, owner] = stamp.split("\n");
    if (
      identity !== folderStamp(path) ||
      !owner ||
      (runId !== undefined && runId !== owner)
    ) {
      return null;
    }
    text = readFileSync(join(gitDirectory, REGISTRATION_FILE), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
  const id = text.trim();
  return REGISTRATION_ID_PATTERN.test(id) ? id : null;
};

/**
 * Marks the worktree `prepare-agent` just created for a Queue or Sweep run
 * with a new registration ID, its physical folder identity and the owning
 * run ID in its private Git directory. An interrupted preparation resumed from an existing
 * checkout never creates a marker.
 * Finalization records the ID it finds and never makes one, so a checkout
 * made again at the same path before the run closes, which has a new
 * private directory, is never taken for the one the run created. A failure
 * leaves the worktree unmarked, which only means it is never moved
 * automatically, so this never throws.
 */
export const markQueuedWorktree = (
  lease: Pick<LoopLease, "commonGitDirectory" | "runId" | "mode">,
  worktreePath: string
): void => {
  if (lease.mode !== "queue" && lease.mode !== "sweep") {
    return;
  }
  try {
    const gitDirectory = privateGitDirectory(
      lease.commonGitDirectory,
      worktreePath
    );
    if (!gitDirectory) {
      return;
    }
    const id = randomUUID();
    writeFileSync(join(gitDirectory, REGISTRATION_FILE), `${id}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    writeFileSync(
      join(gitDirectory, `${REGISTRATION_FILE}.folder`),
      `${folderStamp(worktreePath)}\n${lease.runId}`,
      { flag: "wx", mode: 0o600 }
    );
  } catch {
    // Any incomplete marker makes this registration ineligible.
  }
};

// The ID `markQueuedWorktree` wrote for this worktree, or null.
const existingRegistrationId = (
  lease: LoopLease,
  worktreePath: string
): string | null => {
  try {
    const gitDirectory = privateGitDirectory(
      lease.commonGitDirectory,
      worktreePath
    );
    return gitDirectory
      ? readRegistrationId(gitDirectory, worktreePath, lease.runId)
      : null;
  } catch {
    return null;
  }
};

const recordPath = (commonGitDirectory: string, runId: string): string =>
  resolve(recordsDirectory(commonGitDirectory), `${runId}.json`);

/**
 * Writes the record, or deletes the record file once no worktree is left
 * in it. Only this bookkeeping file is ever deleted, never a worktree.
 */
export const writeQueuedWorktreesRecord = (
  commonGitDirectory: string,
  record: QueuedWorktreesRecord
): void => {
  const path = recordPath(commonGitDirectory, record.runId);
  if (record.worktrees.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  const validated = validateSchema<QueuedWorktreesRecord>(
    "queued-worktrees",
    record
  );
  ensureStateDirectory(
    commonGitDirectory,
    recordsDirectory(commonGitDirectory)
  );
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
};

/**
 * Every well-formed record, oldest file name first. A record that is
 * missing, unreadable, or not exactly this shape is skipped: a record only
 * ever allows a move to the Trash, so skipping it keeps its worktrees. That
 * includes any record without the target binding or the registration ID.
 */
export const readQueuedWorktreesRecords = (
  commonGitDirectory: string
): QueuedWorktreesRecord[] => {
  const directory = recordsDirectory(commonGitDirectory);
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const records: QueuedWorktreesRecord[] = [];
  for (const name of names.sort((left, right) => left.localeCompare(right))) {
    try {
      const record = validateSchema<QueuedWorktreesRecord>(
        "queued-worktrees",
        JSON.parse(readFileSync(resolve(directory, name), "utf8")) as unknown
      );
      if (name === `${record.runId}.json`) {
        records.push(record);
      }
    } catch {
      // Skipped, as above.
    }
  }
  return records;
};

export interface KeptQueuedWorktreesResult {
  /** Why some kept worktree will not be cleared by a later run. */
  notes: string[];
  recorded: KeptQueuedWorktree[];
}

/**
 * Records the worktrees a Queue or Sweep run keeps as it closes: each one's
 * branch, the target the run proposed into, and the ID `prepare-agent`
 * wrote into the worktree's private Git directory. A worktree that cannot
 * be bound to all three is left out, with a note, and so is never moved
 * automatically. That includes one without an ID: a worktree an earlier
 * version prepared, or a checkout made again since the run prepared it.
 */
export const recordKeptQueuedWorktrees = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  keptPaths: readonly string[],
  closedAt: string
): KeptQueuedWorktreesResult => {
  const result: KeptQueuedWorktreesResult = { notes: [], recorded: [] };
  if (keptPaths.length === 0) {
    return result;
  }
  const target = queuedTargetBinding(lease.primaryCheckout, lease.targetRef);
  if ("unbound" in target) {
    result.notes.push(
      `A later run will not move this run's kept worktrees to the Trash by itself, because ${target.unbound}, so there is no remote to ask whether their work is merged: ${keptPaths.join(", ")}.`
    );
    return result;
  }
  for (const path of keptPaths) {
    const worktree = inventory.worktrees.find((item) => item.path === path);
    if (
      !worktree?.branch ||
      worktree.isPrimary ||
      isLossyName(worktree.branch)
    ) {
      result.notes.push(
        `A later run will not move kept worktree ${path} to the Trash by itself: it is not a linked worktree on a branch that can be named exactly.`
      );
      continue;
    }
    const registrationId = existingRegistrationId(lease, path);
    if (!registrationId) {
      result.notes.push(
        `A later run will not move kept worktree ${path} to the Trash by itself: it does not carry the mark this run's prepare-agent gives a worktree it creates (an earlier version prepared it, or it was made again since).`
      );
      continue;
    }
    result.recorded.push({
      branch: worktree.branch,
      path,
      registrationId,
      target,
    });
  }
  writeQueuedWorktreesRecord(lease.commonGitDirectory, {
    closedAt,
    kind: "queued-worktrees",
    mode: lease.mode === "sweep" ? "sweep" : "queue",
    runId: lease.runId,
    schemaVersion: 1,
    worktrees: result.recorded,
  });
  return result;
};
