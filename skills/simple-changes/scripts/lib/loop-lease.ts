// biome-ignore-all lint/performance/noBarrelFile: loop-lease.ts keeps the import path callers and repository forks already use; the implementation lives in the loop-lease-*.ts modules.

export type { LeaseLiveness, LoopLockOwner } from "./loop-lease-core.ts";
export {
  controllerBindingPath,
  LEASE_STALE_AFTER_MS,
  leaseLiveness,
  loopLeasePath,
  loopLockPath,
  loopManifestDigest,
  readControllerBinding,
  readLeaseFromCommonDirectory,
  readLoopLease,
  resolvedCurrentTargetRevision,
  SESSION_EXIT_GRACE_MS,
  turnEndReminder,
  withLoopStateLock,
  withLoopStateLockWaiting,
} from "./loop-lease-core.ts";
export type {
  FinalizationCleanupResult,
  FinalizationReleasedClaim,
  FinalizationRemovedBranch,
  LoopEndResult,
  LoopFinalizationOptions,
  LoopFinalizationReceipt,
  LoopFinalizationResult,
  LoopUnmutatedClose,
  LoopUnmutatedCloseReceipt,
} from "./loop-lease-finalize.ts";
export { endLoop, finalizeLoop } from "./loop-lease-finalize.ts";
export type {
  GuardedLoopCommand,
  GuardedLoopCommandInput,
  GuardedLoopCommandOptions,
  LoopMutationLeaseContext,
  LoopMutationResult,
  LoopOperationResult,
} from "./loop-lease-mutation.ts";
export {
  emergencyShippingStatus,
  executeLoopMutation,
  guardLoopMutation,
  readControllerLease,
  recordEmergencyShipping,
  withGuardedLoopCommands,
  withLoopMutationLease,
} from "./loop-lease-mutation.ts";
export type {
  LoopCloseEquivalentRecord,
  LoopEquivalenceEvidence,
  LoopLockRecovery,
  LoopRebaselineResult,
  LoopReplanRequest,
  LoopTargetEquivalentCloseResult,
  PostCleanupRecoveryResult,
  StaleLeaseRecoveryReceipt,
} from "./loop-lease-recovery.ts";
export {
  acceptPausedWorktreeChange,
  adoptPausedWorktree,
  closeLoopTargetEquivalent,
  completedRemovalProofForPath,
  frozenRecoveryBlockingViolations,
  loopReplanStatus,
  rebaselineLoopWorktrees,
  recoverLoopLock,
  recoverPostCleanupLoop,
  recoverStaleLoopLease,
  replanLoop,
  retireAbsentWorktree,
  staleLeaseArchivePath,
  takeoverLoop,
} from "./loop-lease-recovery.ts";
export { recordRemoteBranchReconciliation } from "./loop-lease-remote.ts";
export type {
  PreservedSourceApproval,
  ShipmentOutcomeRecord,
  ShipmentScopeReceipt,
} from "./loop-lease-shipment.ts";
export {
  LS_TREE_ENTRY_PATTERN,
  OUTCOME_DRAFT_MARKER,
  OUTCOME_DRAFT_REVIEW,
  recordShipmentOutcome,
  recordShipmentScope,
  targetDiffPaths,
  targetRenameOriginals,
  targetTreeEntry,
} from "./loop-lease-shipment.ts";
export type { LoopStartOptions } from "./loop-lease-start.ts";
export { startLoop } from "./loop-lease-start.ts";
export type { LoopGuidance } from "./loop-lease-status.ts";
export { loopStatus } from "./loop-lease-status.ts";
export type { LoopVerifyOptions } from "./loop-lease-verify.ts";
export { staleClaimRecoveryCommands, verifyLoop } from "./loop-lease-verify.ts";
export type { PreparedAgentWorktree } from "./loop-lease-worktrees.ts";
export {
  authorizeWorktreeRemoval,
  grantLoopOverride,
  markWorktreeResumeReady,
  prepareAgentWorktree,
  retainExcludedWorktree,
} from "./loop-lease-worktrees.ts";
