/**
 * examples/generic-api-pipeline/evaluator.ts
 *
 * ERC-8183-side evaluation helpers for the generic API pipeline example.
 */

import { OnChainSubmitter } from "../../src/chain/OnChainSubmitter.js";
import { ProofBundle } from "../../src/types/index.js";

export async function setupGenericPipelinePolicy(
  policyContractAddress: string,
): Promise<string> {
  const submitter = new OnChainSubmitter(
    process.env.BUYER_PRIVATE_KEY!,
    "base_sepolia",
    undefined,
    { VeritasERC8183Hook: process.env.VERITAS_8183_HOOK_ADDRESS },
  );

  const txHash = await submitter.setPolicy(policyContractAddress);
  console.log(`[GenericEvaluator] Policy contract set. TX: ${txHash}`);
  return txHash;
}

export async function evaluateGenericDeliverable(deliverableJson: string): Promise<{
  accept: boolean;
  reason: string;
}> {
  const deliverable = JSON.parse(deliverableJson);

  if (!deliverable.asset || !deliverable.price || !deliverable.proofBundle) {
    return { accept: false, reason: "Missing required deliverable fields" };
  }

  const bundle: ProofBundle = deliverable.proofBundle;

  if (!bundle.steps || bundle.steps.length < 2) {
    return { accept: false, reason: "Proof bundle must include at least 2 steps" };
  }

  const stepIds = bundle.steps.map((s) => s.stepId);
  if (!stepIds.includes("source_data")) {
    return { accept: false, reason: "Missing source_data proof step" };
  }
  if (!stepIds.includes("risk_score")) {
    return { accept: false, reason: "Missing risk_score proof step" };
  }

  const { computeChainHash } = await import("../../src/utils/hash.js");
  const expectedHash = computeChainHash(bundle.steps.map((s) => s.primusTaskId));
  if (expectedHash !== bundle.chainHash) {
    return { accept: false, reason: "Chain hash integrity check failed" };
  }

  return { accept: true, reason: "Generic Veritas proof bundle verified" };
}

export async function validateGenericOnChain(
  deliverableJson: string,
  jobId: number | bigint,
): Promise<{ verified: boolean; txHash?: string; error?: string }> {
  const deliverable = JSON.parse(deliverableJson);
  const bundle: ProofBundle = deliverable.proofBundle;

  const submitter = new OnChainSubmitter(
    process.env.BUYER_PRIVATE_KEY!,
    "base_sepolia",
    undefined,
    {
      VeritasVerifier: process.env.VERITAS_VERIFIER_ADDRESS,
      VeritasERC8183Hook: process.env.VERITAS_8183_HOOK_ADDRESS,
    },
  );

  return submitter.validateJobSubmission(jobId, bundle);
}

export async function submitGenericOnChain(
  deliverableJson: string,
  jobId: number | bigint,
): Promise<{ verified: boolean; txHash?: string; error?: string }> {
  const deliverable = JSON.parse(deliverableJson);
  const bundle: ProofBundle = deliverable.proofBundle;

  const submitter = new OnChainSubmitter(
    process.env.WALLET_PRIVATE_KEY!,
    "base_sepolia",
    undefined,
    {
      VeritasVerifier: process.env.VERITAS_VERIFIER_ADDRESS,
      VeritasERC8183Hook: process.env.VERITAS_8183_HOOK_ADDRESS,
      ERC8183AgenticCommerce: process.env.ERC8183_AGENTIC_COMMERCE_ADDRESS,
    },
  );

  const dryRun = await submitter.validateJobSubmission(jobId, bundle);
  if (!dryRun.verified) {
    return { verified: false, error: dryRun.error };
  }

  return submitter.submitJob(jobId, bundle);
}
