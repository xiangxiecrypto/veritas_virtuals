/**
 * examples/fact-check/provider.ts
 *
 * Full example: ArAIstotle-style Fact Check ACP Provider
 * integrated with TrustLayer.
 *
 * Flow:
 *  1. Receive ACP Job (onNewTask)
 *  2. Use ProofChainBuilder to:
 *     a. Prove real data source fetch (Reuters)
 *     b. Prove LLM inference call (GPT-4o), referencing step (a) by hash
 *  3. Build ProofBundle
 *  4. Submit Deliverable Memo with proof bundle attached
 */

import AcpClient from "@virtuals-protocol/acp-node";
import {
  ProofChainBuilder,
  buildHashReference,
  sha256,
} from "../../src/index.js";

// ── Config ────────────────────────────────────────────────────

const PRIMUS_APP_ID     = process.env.PRIMUS_APP_ID!;
const PRIMUS_APP_SECRET = process.env.PRIMUS_APP_SECRET!;
const PROVIDER_WALLET   = process.env.AGENT_WALLET_ADDRESS!;
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY!;

// ── ACP Provider Setup ────────────────────────────────────────

const acpClient = new AcpClient({
  acpContractClient: await buildContractClient(),

  onNewTask: async (job) => {
    console.log(`[TrustLayer] New job ${job.id}: ${job.serviceRequirement.claim}`);

    // Validate input
    if (!job.serviceRequirement?.claim) {
      await job.reject("Missing required field: claim");
      return;
    }

    await job.createRequirement(
      JSON.stringify({
        deliverable: "JSON: { verdict, score, summary, sources, proofBundle }",
        trustLayer: true,  // Signals to Buyer that TrustLayer proofs will be included
      }),
      1.00
    );
  },

  onEvaluate: async (job) => {
    // Buyer-side: validate the delivered proof bundle
    const deliverable = JSON.parse(job.deliverable);

    if (!deliverable.proofBundle) {
      // Provider claimed TrustLayer but didn't include bundle
      await job.evaluate(false, "Missing proofBundle in deliverable");
      return;
    }

    // Optional: off-chain pre-check before on-chain verification
    console.log(`[TrustLayer] Verifying proof bundle with ${deliverable.proofBundle.steps.length} steps`);

    // For now: basic format check. In production, call on-chain verifier.
    const hasDataSource = deliverable.proofBundle.steps.some(
      (s: any) => s.stepId === "data_source"
    );
    const hasLLMInference = deliverable.proofBundle.steps.some(
      (s: any) => s.stepId === "llm_inference"
    );

    if (!hasDataSource || !hasLLMInference) {
      await job.evaluate(false, "ProofBundle missing required steps");
      return;
    }

    await job.evaluate(true, "TrustLayer proof bundle verified");
  },
});

await acpClient.init();

// ── Core Fact Check Logic ─────────────────────────────────────

async function executeFactCheck(job: any): Promise<void> {
  const claim: string = job.serviceRequirement.claim;

  const builder = new ProofChainBuilder({
    primusAppId:    PRIMUS_APP_ID,
    primusAppSecret: PRIMUS_APP_SECRET,
    providerWallet: PROVIDER_WALLET,
  });

  // ── Step 1: Fetch and prove real data source ──────────────
  console.log("[TrustLayer] Step 1: Proving data source fetch...");

  const dataSourceResult = await builder.addStep({
    stepId: "data_source",
    url: `https://reuters.com/api/search?q=${encodeURIComponent(claim)}`,
    method: "GET",
    headers: {
      "User-Agent": "TrustLayer-Agent/1.0",
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

  console.log(`[TrustLayer] Data source proven. Hash: ${dataSourceResult.dataHash.slice(0, 16)}...`);

  const articleContent = dataSourceResult.data["article_content"] ?? "";
  const articleTitle   = dataSourceResult.data["article_title"] ?? "(no title)";

  // ── Step 2: LLM inference with chain linkage ──────────────
  console.log("[TrustLayer] Step 2: Proving LLM inference...");

  const llmResult = await builder.addStep({
    stepId: "llm_inference",
    url: "https://api.openai.com/v1/chat/completions",
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    // bodyBuilder receives results of previous steps.
    // CRITICAL: the hash reference embeds SHA256(articleContent)
    // into the prompt, creating the cryptographic chain linkage.
    bodyBuilder: (prevSteps) => {
      const content = prevSteps["data_source"].data["article_content"];
      const hashRef = buildHashReference("data_source", content);

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
              articleContent.slice(0, 4000), // Truncate to stay within token limits
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
      sourceField: "article_content",  // Enforces: SHA256(content) ∈ LLM prompt
    },
  });

  console.log(`[TrustLayer] LLM inference proven. Verdict: ${llmResult.data["verdict"]}`);

  // ── Build final proof bundle ──────────────────────────────
  const proofBundle = await builder.build();

  // ── Submit ACP Deliverable Memo ───────────────────────────
  const deliverable = {
    verdict:    llmResult.data["verdict"],
    score:      parseInt(llmResult.data["score"]),
    summary:    llmResult.data["summary"],
    model_used: llmResult.data["model_used"],
    sources: [
      {
        title: articleTitle,
        url: dataSourceResult.attestation.attestation.request[0].url,
        verified_at: dataSourceResult.attestation.attestation.timestamp,
      },
    ],
    // The proof bundle is what enables on-chain verification
    proofBundle,
  };

  await job.deliver(JSON.stringify(deliverable));
  console.log(`[TrustLayer] Delivered. Chain hash: ${proofBundle.chainHash}`);
}

async function buildContractClient() {
  const { AcpContractClientV2 } = await import("@virtuals-protocol/acp-node");
  return AcpContractClientV2.build(
    process.env.WALLET_PRIVATE_KEY!,
    parseInt(process.env.SESSION_ENTITY_KEY_ID!),
    process.env.AGENT_WALLET_ADDRESS!,
  );
}
