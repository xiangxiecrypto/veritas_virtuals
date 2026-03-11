/**
 * examples/fact-check/evaluator.ts
 *
 * Buyer-side evaluator for a fact-check ACP Job.
 *
 * Setup flow (one-time):
 *   1. Deploy a FactCheckPolicy contract (see contracts/policies/FactCheckPolicy.sol)
 *   2. Call hook.setPolicy(factCheckPolicyAddress)
 *
 * Runtime flow (fully automated, zero human intervention):
 *   1. Provider delivers a proof bundle
 *   2. ACP Job calls hook.verifyDeliverable(...)
 *   3. Hook verifies proof authenticity via TrustLayerVerifier
 *   4. Hook calls FactCheckPolicy.check(bundle, provider)
 *   5. If both pass → escrow releases
 */

import { OnChainSubmitter } from "../../src/chain/OnChainSubmitter.js";
import { ProofBundle } from "../../src/types/index.js";

// ── Phase 1: One-time setup ─────────────────────────────────

/**
 * Register the evaluator's policy contract address on the hook.
 * The policy contract (e.g. FactCheckPolicy) must already be deployed.
 */
export async function setupEvaluator(
  policyContractAddress: string,
): Promise<string> {
  const submitter = new OnChainSubmitter(
    process.env.BUYER_PRIVATE_KEY!,
    "base_sepolia",
    undefined,
    { TrustLayerACPHook: process.env.TRUST_LAYER_ACP_HOOK_ADDRESS },
  );

  const txHash = await submitter.setPolicy(policyContractAddress);
  console.log(`[Evaluator] Policy contract set. TX: ${txHash}`);
  return txHash;
}

// ── Phase 2: Automated verification ──────────────────────────

/**
 * Optional off-chain pre-check. Lightweight validation that can run
 * in the evaluator's runtime without touching the chain.
 */
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
 * Submit to the on-chain hook for fully automated verification.
 * The hook enforces proof authenticity + evaluator policy in one tx.
 */
export async function evaluateOnChain(
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

// ── Example ACP onEvaluate integration ───────────────────────

export function createEvaluator(evaluatorAddress: string, onChain = false) {
  return async (job: any) => {
    const { accept, reason } = await evaluateDeliverable(job.deliverable);

    if (!accept) {
      console.log(`[Buyer] Rejecting: ${reason}`);
      await job.evaluate(false, reason);
      return;
    }

    if (onChain) {
      const result = await evaluateOnChain(
        job.deliverable,
        job.providerAddress,
        evaluatorAddress,
      );
      if (!result.verified) {
        await job.evaluate(false, `On-chain verification failed: ${result.error}`);
        return;
      }
      console.log(`[Buyer] On-chain verified. TX: ${result.txHash}`);
    }

    const deliverable = JSON.parse(job.deliverable);
    console.log(`[Buyer] Accepting. Verdict: ${deliverable.verdict}, Score: ${deliverable.score}`);
    await job.evaluate(true, `Verified. Verdict: ${deliverable.verdict}`);
  };
}
