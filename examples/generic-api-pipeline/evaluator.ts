/**
 * examples/generic-api-pipeline/evaluator.ts
 *
 * Buyer-side evaluation for the generic API pipeline example.
 *
 * Setup flow (one-time):
 *   1. Deploy a custom IEvaluatorPolicy contract (e.g. GenericPipelinePolicy)
 *   2. Call hook.setPolicy(policyContractAddress)
 *
 * After that, verifyDeliverable is fully automated.
 */

import { OnChainSubmitter } from "../../src/chain/OnChainSubmitter.js";
import { ProofBundle } from "../../src/types/index.js";

// ── One-time policy setup ────────────────────────────────────

/**
 * Point this evaluator to a deployed IEvaluatorPolicy contract.
 */
export async function setupGenericPipelinePolicy(
  policyContractAddress: string,
): Promise<string> {
  const submitter = new OnChainSubmitter(
    process.env.BUYER_PRIVATE_KEY!,
    "base_sepolia",
    undefined,
    { TrustLayerACPHook: process.env.TRUST_LAYER_ACP_HOOK_ADDRESS },
  );

  const txHash = await submitter.setPolicy(policyContractAddress);
  console.log(`[GenericEvaluator] Policy contract set. TX: ${txHash}`);
  return txHash;
}

// ── Off-chain pre-check ──────────────────────────────────────

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

  return { accept: true, reason: "Generic TrustLayer proof bundle verified" };
}

// ── On-chain automated verification ──────────────────────────

export async function evaluateGenericOnChain(
  deliverableJson: string,
  providerAddress: string,
  evaluatorAddress: string,
  jobId: number | bigint = 0,
): Promise<{ verified: boolean; txHash?: string; error?: string }> {
  const deliverable = JSON.parse(deliverableJson);
  const bundle: ProofBundle = deliverable.proofBundle;

  const submitter = new OnChainSubmitter(
    process.env.BUYER_PRIVATE_KEY!,
    "base_sepolia",
    undefined,
    {
      TrustLayerVerifier: process.env.TRUST_LAYER_VERIFIER_ADDRESS,
      TrustLayerACPHook: process.env.TRUST_LAYER_ACP_HOOK_ADDRESS,
    },
  );

  const dryRun = await submitter.verifyBundle(bundle, providerAddress);
  if (!dryRun.verified) {
    return { verified: false, error: dryRun.error };
  }

  return submitter.submitBundle(jobId, bundle, providerAddress, evaluatorAddress);
}
