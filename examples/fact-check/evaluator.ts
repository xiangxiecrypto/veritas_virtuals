/**
 * examples/fact-check/evaluator.ts
 *
 * Evaluator-side helpers for ERC-8183 fact-check jobs.
 *
 * Setup:
 *   1. Deploy `FactCheckPolicy`
 *   2. Call `hook.setPolicy(policyAddress)` from the evaluator wallet
 *
 * Runtime:
 *   1. Provider prepares a deliverable and Veritas proof bundle
 *   2. Provider submits the job with `deliverable == bundle.chainHash`
 *   3. VeritasERC8183Hook verifies proof authenticity + evaluator policy
 *   4. Evaluator may safely complete the job escrow
 */

import { OnChainSubmitter } from "../../src/chain/OnChainSubmitter.js";
import { ProofBundle } from "../../src/types/index.js";

export async function setupEvaluator(
  policyContractAddress: string,
): Promise<string> {
  const submitter = new OnChainSubmitter(
    process.env.BUYER_PRIVATE_KEY!,
    "base_sepolia",
    undefined,
    { VeritasERC8183Hook: process.env.VERITAS_8183_HOOK_ADDRESS },
  );

  const txHash = await submitter.setPolicy(policyContractAddress);
  console.log(`[Evaluator] Policy contract set. TX: ${txHash}`);
  return txHash;
}

export async function evaluateDeliverable(deliverableJson: string): Promise<{
  accept: boolean;
  reason: string;
}> {
  const deliverable = JSON.parse(deliverableJson);

  if (!deliverable.verdict || !deliverable.score || !deliverable.proofBundle) {
    return { accept: false, reason: "Missing required fields in deliverable" };
  }

  const bundle: ProofBundle = deliverable.proofBundle;

  if (!bundle.steps || bundle.steps.length === 0) {
    return { accept: false, reason: "Empty proof bundle" };
  }

  const stepIds = bundle.steps.map((s) => s.stepId);
  if (!stepIds.includes("data_source")) {
    return { accept: false, reason: "Missing data_source proof step" };
  }
  if (!stepIds.includes("llm_inference")) {
    return { accept: false, reason: "Missing llm_inference proof step" };
  }

  const { computeChainHash } = await import("../../src/utils/hash.js");
  const primusTaskIds = bundle.steps.map((s) => s.primusTaskId);
  const expectedHash = computeChainHash(primusTaskIds);

  if (expectedHash !== bundle.chainHash) {
    return { accept: false, reason: "Chain hash integrity check failed" };
  }

  if (deliverable.score < 0 || deliverable.score > 100) {
    return { accept: false, reason: "Score out of range [0-100]" };
  }

  return { accept: true, reason: "All off-chain checks passed" };
}

/**
 * Dry-run the same ERC-8183 hook validation that will execute during submit().
 */
export async function validateFactCheckSubmission(
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

/**
 * Provider-side helper: submit the deliverable/bundle into an ERC-8183 job.
 */
export async function submitFactCheckJob(
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
