/**
 * examples/fact-check/evaluator.ts
 *
 * Buyer-side: How to evaluate a Deliverable Memo that contains
 * a TrustLayer ProofBundle.
 *
 * Two modes:
 *   1. Off-chain: SDK validates attestation signatures locally
 *   2. On-chain:  Submit to TrustLayerVerifier on Base for full verification
 */

import { OnChainSubmitter } from "../../src/chain/OnChainSubmitter.js";
import { ProofBundle } from "../../src/types/index.js";

// ── Off-chain Evaluation (inside ACP onEvaluate callback) ─────

export async function evaluateDeliverable(deliverableJson: string): Promise<{
  accept: boolean;
  reason: string;
}> {
  const deliverable = JSON.parse(deliverableJson);

  // ── Basic schema validation ─────────────────────────────
  if (!deliverable.verdict || !deliverable.score || !deliverable.proofBundle) {
    return { accept: false, reason: "Missing required fields in deliverable" };
  }

  const bundle: ProofBundle = deliverable.proofBundle;

  // ── Validate bundle structure ───────────────────────────
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

  // ── Validate chain hash integrity (off-chain) ───────────
  // Re-derive the expected chain hash from taskIds
  const { computeChainHash } = await import("../../src/utils/hash.js");
  const taskIds = bundle.steps.map((s) => s.attestation.taskId);
  const expectedHash = computeChainHash(taskIds);

  if (expectedHash !== bundle.chainHash) {
    return { accept: false, reason: "Chain hash integrity check failed" };
  }

  // ── Validate timestamps (not older than 10 minutes) ─────
  const tenMinutesAgo = Date.now() - 600_000;
  for (const step of bundle.steps) {
    if (step.attestation.attestation.timestamp < tenMinutesAgo) {
      return {
        accept: false,
        reason: `Step "${step.stepId}" attestation is too old`,
      };
    }
  }

  // ── Validate score range ────────────────────────────────
  if (deliverable.score < 0 || deliverable.score > 100) {
    return { accept: false, reason: "Score out of range [0-100]" };
  }

  return { accept: true, reason: "All off-chain checks passed" };
}

// ── On-chain Evaluation (full verification on Base) ───────────

export async function evaluateOnChain(
  deliverableJson: string,
  providerAddress: string,
): Promise<{ verified: boolean; txHash?: string; error?: string }> {
  const deliverable = JSON.parse(deliverableJson);
  const bundle: ProofBundle = deliverable.proofBundle;

  const submitter = new OnChainSubmitter(
    process.env.BUYER_PRIVATE_KEY!,
    "base_mainnet",
  );

  // Dry-run first (no gas)
  const dryRun = await submitter.verifyBundle(bundle, providerAddress);
  if (!dryRun.verified) {
    return { verified: false, error: dryRun.error };
  }

  // Submit on-chain for permanent record
  return submitter.submitBundle(bundle, providerAddress);
}

// ── Example ACP onEvaluate integration ───────────────────────

export function createEvaluator(onChain = false) {
  return async (job: any) => {
    const { accept, reason } = await evaluateDeliverable(job.deliverable);

    if (!accept) {
      console.log(`[Buyer] Rejecting: ${reason}`);
      await job.evaluate(false, reason);
      return;
    }

    if (onChain) {
      // Full on-chain verification before accepting
      const result = await evaluateOnChain(job.deliverable, job.providerAddress);
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
