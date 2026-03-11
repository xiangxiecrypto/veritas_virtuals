/**
 * examples/generic-api-pipeline/provider.ts
 *
 * Generic TrustLayer example:
 *   Step 1: fetch source data from a trusted HTTPS API
 *   Step 2: send verified source data into a downstream HTTPS scoring API
 *
 * This example intentionally avoids fact-check-specific logic. It demonstrates
 * how any HTTPS pipeline can be turned into a proof chain.
 */

import {
  ProofChainBuilder,
  buildHashReference,
} from "../../src/index.js";

export interface GenericPipelineDeliverable {
  asset: string;
  price: string;
  currency: string;
  riskScore: string;
  riskBand: string;
  proofBundle: Awaited<ReturnType<ProofChainBuilder["build"]>>;
}

/**
 * Build a generic 2-step proof chain for:
 *   source data API -> downstream scoring API
 *
 * Notes:
 * - `mode` is omitted on both steps, so TrustLayer defaults to `proxytls`.
 * - Replace the placeholder URLs with real allowlisted domains in production.
 */
export async function buildGenericPipelineDeliverable(
  asset: string,
): Promise<GenericPipelineDeliverable> {
  const builder = new ProofChainBuilder({
    primusAppId: process.env.PRIMUS_APP_ID!,
    primusAppSecret: process.env.PRIMUS_APP_SECRET!,
    providerWallet: process.env.AGENT_WALLET_ADDRESS!,
    trustedDomains: [
      "api.marketdata.example.com",
      "api.risk-engine.example.com",
    ],
  });

  const sourceStep = await builder.addStep({
    stepId: "source_data",
    url: `https://api.marketdata.example.com/v1/price?asset=${encodeURIComponent(asset)}`,
    method: "GET",
    headers: {},
    responseResolves: [
      { keyName: "asset", parseType: "json", parsePath: "$.asset" },
      { keyName: "price", parseType: "json", parsePath: "$.price" },
      { keyName: "currency", parseType: "json", parsePath: "$.currency" },
    ],
  });

  const scoringStep = await builder.addStep({
    stepId: "risk_score",
    url: "https://api.risk-engine.example.com/v1/score",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    bodyBuilder: (prev) => {
      const resolvedAsset = prev["source_data"].data["asset"];
      const price = prev["source_data"].data["price"];
      const currency = prev["source_data"].data["currency"];
      const hashRef = buildHashReference(
        "source_data",
        prev["source_data"].attestation.attestation.data,
      );

      return JSON.stringify({
        asset: resolvedAsset,
        price,
        currency,
        evidence: hashRef,
      });
    },
    responseResolves: [
      { keyName: "risk_score", parseType: "json", parsePath: "$.score" },
      { keyName: "risk_band", parseType: "json", parsePath: "$.band" },
    ],
    dependsOn: {
      stepId: "source_data",
      sourceField: "price",
    },
  });

  const proofBundle = await builder.build();

  return {
    asset: sourceStep.data["asset"],
    price: sourceStep.data["price"],
    currency: sourceStep.data["currency"],
    riskScore: scoringStep.data["risk_score"],
    riskBand: scoringStep.data["risk_band"],
    proofBundle,
  };
}

