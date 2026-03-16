import { OnChainSubmitter } from "../../src/chain/OnChainSubmitter.js";
import {
  parseJsonObject,
  type TokenAnalysisDeliverable,
  type TokenAnalysisRequirement,
} from "./common.js";

/**
 * Build the request object a client would share off-chain before opening
 * an ERC-8183 job.
 */
export function buildTokenAnalysisRequest(
  requirement: TokenAnalysisRequirement,
): TokenAnalysisRequirement {
  const token = requirement.token ?? requirement.coingeckoId;
  if (!token) {
    throw new Error("Token analysis request requires `token` or `coingeckoId`");
  }
  return requirement;
}

/**
 * Off-chain consumer-side validation of a delivered token analysis object.
 */
export function reviewTokenAnalysisDeliverable(
  deliverableJson: string,
): { accept: boolean; reason: string } {
  const deliverable = parseJsonObject<TokenAnalysisDeliverable>(deliverableJson);
  if (!deliverable) {
    return { accept: false, reason: "Deliverable must be a JSON object" };
  }

  if (!deliverable.requestedToken || !deliverable.proofBundle) {
    return { accept: false, reason: "Missing requestedToken or proofBundle" };
  }

  if (!deliverable.attestedEndpoints?.dataSource.includes("api.coingecko.com")) {
    return { accept: false, reason: "Unexpected source endpoint" };
  }

  if (!deliverable.attestedEndpoints?.llm.includes("api.z.ai")) {
    return { accept: false, reason: "Unexpected LLM endpoint" };
  }

  return { accept: true, reason: "Deliverable structure looks valid" };
}

/**
 * Query the Veritas hook cache to confirm a provider bundle already passed
 * ERC-8183 hook verification on-chain.
 */
export async function isTokenAnalysisVerifiedOnChain(
  providerAddress: string,
  chainHash: string,
): Promise<boolean> {
  const submitter = new OnChainSubmitter(
    process.env.BUYER_PRIVATE_KEY!,
    "base_sepolia",
    undefined,
    {
      VeritasERC8183Hook: process.env.VERITAS_8183_HOOK_ADDRESS,
    },
  );

  return submitter.isVerified(providerAddress, chainHash);
}
