/**
 * examples/fact-check/provider.ts
 *
 * Veritas fact-check provider example:
 *   1. Fetch source data from a news API
 *   2. Send the verified source into an LLM
 *   3. Build a proof bundle that can later be submitted through ERC-8183
 */

import {
  ProofChainBuilder,
  buildHashReference,
} from "../../src/index.js";

export interface FactCheckDeliverable {
  verdict: string;
  score: number;
  summary: string;
  model_used: string;
  sources: Array<{
    title: string;
    url: string;
    verified_at: number;
  }>;
  proofBundle: Awaited<ReturnType<ProofChainBuilder["build"]>>;
}

// ── Config ────────────────────────────────────────────────────

const PRIMUS_APP_ID     = process.env.PRIMUS_APP_ID!;
const PRIMUS_APP_SECRET = process.env.PRIMUS_APP_SECRET!;
const PROVIDER_WALLET   = process.env.AGENT_WALLET_ADDRESS!;
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY!;

export async function buildFactCheckDeliverable(
  claim: string,
): Promise<FactCheckDeliverable> {
  const builder = new ProofChainBuilder({
    primusAppId:    PRIMUS_APP_ID,
    primusAppSecret: PRIMUS_APP_SECRET,
    providerWallet: PROVIDER_WALLET,
  });

  // ── Step 1: Fetch and prove real data source ──────────────
  console.log("[Veritas] Step 1: Proving data source fetch...");

  const dataSourceResult = await builder.addStep({
    stepId: "data_source",
    url: `https://reuters.com/api/search?q=${encodeURIComponent(claim)}`,
    method: "GET",
    headers: {
      "User-Agent": "Veritas-Agent/1.0",
    },
    responseResolves: [
      {
        keyName: "article_title",
        parseType: "json",
        parsePath: "$.results[0].title",
      },
      {
        keyName: "article_content",
        parseType: "json",
        parsePath: "$.results[0].body",
      },
      {
        keyName: "published_at",
        parseType: "json",
        parsePath: "$.results[0].publishedAt",
      },
    ],
    // mode omitted -> defaults to proxytls
  });

  console.log(`[Veritas] Data source proven. Hash: ${dataSourceResult.dataHash.slice(0, 16)}...`);

  const articleContent = dataSourceResult.data["article_content"] ?? "";
  const articleTitle   = dataSourceResult.data["article_title"] ?? "(no title)";

  // ── Step 2: LLM inference with chain linkage ──────────────
  console.log("[Veritas] Step 2: Proving LLM inference...");

  const llmResult = await builder.addStep({
    stepId: "llm_inference",
    url: "https://api.openai.com/v1/chat/completions",
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    // bodyBuilder receives results of previous steps.
    // CRITICAL: the hash reference embeds SHA256(previous attestation data)
    // into the prompt, creating the cryptographic chain linkage that the
    // on-chain verifier can reproduce exactly.
    bodyBuilder: (prevSteps) => {
      const content = prevSteps["data_source"].data["article_content"];
      const hashRef = buildHashReference(
        "data_source",
        prevSteps["data_source"].attestation.attestation.data,
      );

      return JSON.stringify({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: [
              "You are a fact-checking AI. Analyze the provided source material and evaluate the claim.",
              "Respond ONLY with valid JSON: { \"verdict\": \"True|False|Partially True|Unverifiable\", \"score\": 0-100, \"summary\": \"string\", \"reasoning\": \"string\" }",
            ].join("\n"),
          },
          {
            role: "user",
            content: [
              // The hash reference is the chain linkage anchor.
              // It proves this prompt used the exact data from step 1.
              `${hashRef}`,
              ``,
              `SOURCE ARTICLE: "${articleTitle}"`,
              `---`,
              articleContent.slice(0, 4000),
              `---`,
              ``,
              `CLAIM TO VERIFY: "${claim}"`,
              ``,
              `Respond with JSON only.`,
            ].join("\n"),
          },
        ],
        seed: 42,          // Deterministic seed for reproducibility
        temperature: 0.1,  // Low temperature for consistent fact-checking
        max_tokens: 500,
        response_format: { type: "json_object" },
      });
    },
    responseResolves: [
      {
        keyName: "verdict",
        parseType: "json",
        parsePath: "$.choices[0].message.content.verdict",
      },
      {
        keyName: "score",
        parseType: "json",
        parsePath: "$.choices[0].message.content.score",
      },
      {
        keyName: "summary",
        parseType: "json",
        parsePath: "$.choices[0].message.content.summary",
      },
      {
        keyName: "model_used",
        parseType: "json",
        parsePath: "$.model",
      },
    ],
    dependsOn: {
      stepId: "data_source",
      sourceField: "article_content",
    },
  });

  console.log(`[Veritas] LLM inference proven. Verdict: ${llmResult.data["verdict"]}`);

  const proofBundle = await builder.build();

  return {
    verdict:    llmResult.data["verdict"],
    score:      parseInt(llmResult.data["score"]),
    summary:    llmResult.data["summary"],
    model_used: llmResult.data["model_used"],
    sources: [
      {
        title: articleTitle,
        url: dataSourceResult.attestation.attestation.request.url,
        verified_at: dataSourceResult.attestation.attestation.timestamp,
      },
    ],
    proofBundle,
  };
}
