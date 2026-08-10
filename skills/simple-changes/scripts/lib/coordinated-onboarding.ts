import { sha256Json } from "./hash.ts";

export type OnboardingOwner = "simple-changes" | "simple-changelogs";

export interface OnboardingContribution {
  destination: string;
  owner: OnboardingOwner;
  policyDigest: string;
  questions: Array<{
    id: string;
    prompt: string;
  }>;
  summary: string;
}

export interface CoordinatedOnboardingTransaction {
  owners: Array<{
    destination: string;
    owner: OnboardingOwner;
    policyDigest: string;
    status: "pending" | "completed" | "failed";
    writeReceiptDigest: string | null;
  }>;
  status: "pending" | "completed" | "partial";
  transactionId: string;
}

export interface CoordinatedOnboardingPlan {
  confirmation: string;
  questions: OnboardingContribution["questions"];
  transaction: CoordinatedOnboardingTransaction;
}

const transactionStatus = (
  owners: CoordinatedOnboardingTransaction["owners"]
): CoordinatedOnboardingTransaction["status"] => {
  if (owners.every((owner) => owner.status === "completed")) {
    return "completed";
  }
  if (owners.some((owner) => owner.status !== "pending")) {
    return "partial";
  }
  return "pending";
};

export const coordinateOnboarding = (
  transactionId: string,
  contributions: OnboardingContribution[]
): CoordinatedOnboardingPlan => {
  const owners = contributions.map((contribution) => ({
    destination: contribution.destination,
    owner: contribution.owner,
    policyDigest: contribution.policyDigest,
    status: "pending" as const,
    writeReceiptDigest: null,
  }));
  const destinations = contributions.map(
    (contribution) =>
      `${contribution.owner} -> ${contribution.destination}: ${contribution.summary}`
  );
  return {
    confirmation: [
      "Confirm these independently owned preferences:",
      ...destinations,
      "Each owner writes only its own destination. A partial write resumes without rolling back the completed owner.",
    ].join("\n"),
    questions: contributions.flatMap((contribution) => contribution.questions),
    transaction: {
      owners,
      status: "pending",
      transactionId,
    },
  };
};

export const recordOnboardingOwnerWrite = (
  transaction: CoordinatedOnboardingTransaction,
  owner: OnboardingOwner,
  writeReceipt: unknown
): CoordinatedOnboardingTransaction => {
  const owners = transaction.owners.map((entry) =>
    entry.owner === owner
      ? {
          ...entry,
          status: "completed" as const,
          writeReceiptDigest: sha256Json(writeReceipt),
        }
      : entry
  );
  return {
    ...transaction,
    owners,
    status: transactionStatus(owners),
  };
};

export const recordOnboardingOwnerFailure = (
  transaction: CoordinatedOnboardingTransaction,
  owner: OnboardingOwner
): CoordinatedOnboardingTransaction => {
  const owners = transaction.owners.map((entry) =>
    entry.owner === owner && entry.status !== "completed"
      ? { ...entry, status: "failed" as const }
      : entry
  );
  return {
    ...transaction,
    owners,
    status: transactionStatus(owners),
  };
};

export const pendingOnboardingOwners = (
  transaction: CoordinatedOnboardingTransaction
): OnboardingOwner[] =>
  transaction.owners
    .filter((owner) => owner.status !== "completed")
    .map((owner) => owner.owner);
