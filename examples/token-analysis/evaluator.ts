import { OnChainSubmitter } from "../../src/chain/OnChainSubmitter.js";
import { ProofBundle } from "../../src/types/index.js";
import {
  asFiniteNumber,
  parseJsonObject,
  type TokenAnalysisDeliverable,
} from "./common.js";

export async function setupTokenAnalysisPolicy(
  policyContractAddress: string,
): Promise<string> {
  const submitter = new OnChainSubmitter(
    process.env.BUYER_PRIVATE_KEY!,
    "base_sepolia",
    undefined,
    { VeritasERC8183Hook: process.env.VERITAS_8183_HOOK_ADDRESS },
  );

  const txHash = await submitter.setPolicy(policyContractAddress);
  console.log(`[TokenAnalysisEvaluator] Policy contract set. TX: ${txHash}`);
  return txHash;
}

export async function evaluateTokenAnalysisDeliverable(
  deliverableJson: string,
): Promise<{ accept: boolean; reason: string }> {
  const deliverable = parseJsonObject<TokenAnalysisDeliverable>(deliverableJson);
  if (!deliverable) {
    return { accept: false, reason: "Deliverable must be a JSON object" };
  }

  if (
    !deliverable.requestedToken ||
    !deliverable.coingeckoId ||
    !deliverable.llmAnalysis ||
    !deliverable.proofBundle
  ) {
    return { accept: false, reason: "Missing required token analysis fields" };
  }

  const bundle: ProofBundle = deliverable.proofBundle;
  if (!bundle.steps || bundle.steps.length < 2) {
    return { accept: false, reason: "Proof bundle must include >= 2 steps" };
  }

  const stepIds = bundle.steps.map((step) => step.stepId);
  if (!stepIds.includes("data_source")) {
    return { accept: false, reason: "Missing data_source proof step" };
  }
  if (!stepIds.includes("llm_inference")) {
    return { accept: false, reason: "Missing llm_inference proof step" };
  }

  const { computeChainHash } = await import("../../src/utils/hash.js");
  const expectedHash = computeChainHash(bundle.steps.map((step) => step.primusTaskId));
  if (expectedHash !== bundle.chainHash) {
    return { accept: false, reason: "Chain hash integrity check failed" };
  }

  if (!deliverable.attestedEndpoints?.dataSource.includes("api.coingecko.com")) {
    return { accept: false, reason: "Untrusted data source endpoint" };
  }
  if (!deliverable.attestedEndpoints?.llm.includes("api.z.ai")) {
    return { accept: false, reason: "Untrusted LLM endpoint" };
  }

  const confidence = asFiniteNumber(deliverable.llmAnalysis.confidence);
  if (confidence == null || confidence < 0 || confidence > 100) {
    return { accept: false, reason: "LLM confidence must be in [0, 100]" };
  }

  if (!["buy", "sell", "hold"].includes(deliverable.llmAnalysis.recommendation)) {
    return { accept: false, reason: "Unsupported recommendation value" };
  }

  return { accept: true, reason: "Token analysis deliverable passed off-chain checks" };
}

export async function validateTokenAnalysisOnChain(
  deliverableJson: string,
  jobId: number | bigint,
): Promise<{ verified: boolean; txHash?: string; error?: string }> {
  const deliverable = parseJsonObject<TokenAnalysisDeliverable>(deliverableJson);
  if (!deliverable?.proofBundle) {
    return { verified: false, error: "Missing proofBundle in deliverable" };
  }

  const submitter = new OnChainSubmitter(
    process.env.BUYER_PRIVATE_KEY!,
    "base_sepolia",
    undefined,
    {
      VeritasVerifier: process.env.VERITAS_VERIFIER_ADDRESS,
      VeritasERC8183Hook: process.env.VERITAS_8183_HOOK_ADDRESS,
    },
  );

  return submitter.validateJobSubmission(jobId, deliverable.proofBundle);
}

export async function submitTokenAnalysisOnChain(
  deliverableJson: string,
  jobId: number | bigint,
): Promise<{ verified: boolean; txHash?: string; error?: string }> {
  const deliverable = parseJsonObject<TokenAnalysisDeliverable>(deliverableJson);
  if (!deliverable?.proofBundle) {
    return { verified: false, error: "Missing proofBundle in deliverable" };
  }

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

  const dryRun = await submitter.validateJobSubmission(jobId, deliverable.proofBundle);
  if (!dryRun.verified) {
    return { verified: false, error: dryRun.error };
  }

  return submitter.submitJob(jobId, deliverable.proofBundle);
}
