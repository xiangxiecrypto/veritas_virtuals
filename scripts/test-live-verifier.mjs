import {
  ProofChainBuilder,
  OnChainSubmitter,
  buildHashReference,
} from "../dist/index.js";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function resolveNetworkEnv(network, key) {
  const prefix = network === "base_sepolia" ? "BASE_SEPOLIA" : "BASE_MAINNET";
  return process.env[`${prefix}_${key}`] ?? process.env[key];
}

async function main() {
  const network = process.env.VERITAS_NETWORK ?? "base_sepolia";
  if (network !== "base_mainnet" && network !== "base_sepolia") {
    throw new Error("VERITAS_NETWORK must be base_mainnet or base_sepolia");
  }

  const rpcUrl =
    process.env.VERITAS_RPC_URL ||
    (network === "base_mainnet"
      ? process.env.BASE_RPC_URL
      : process.env.BASE_SEPOLIA_RPC_URL);

  const zaiApiKey =
    process.env.ZAI_API_KEY ??
    process.env.GLM_API_KEY;
  if (!zaiApiKey) {
    throw new Error("ZAI_API_KEY is required");
  }

  const veritasVerifierAddress = resolveNetworkEnv(
    network,
    "VERITAS_VERIFIER_ADDRESS",
  );
  if (!veritasVerifierAddress) {
    throw new Error(
      "VERITAS_VERIFIER_ADDRESS is required. " +
      "You can also set BASE_SEPOLIA_VERITAS_VERIFIER_ADDRESS or BASE_MAINNET_VERITAS_VERIFIER_ADDRESS.",
    );
  }

  const builder = new ProofChainBuilder({
    primusAppId: requireEnv("PRIMUS_APP_ID"),
    primusAppSecret: requireEnv("PRIMUS_APP_SECRET"),
    providerWallet: requireEnv("AGENT_WALLET_ADDRESS"),
  });

  console.log("[live-test] Step 1: generating source-data attestation...");
  const sourceStep = await builder.addStep({
    stepId: "data_source",
    url: "https://api.coinbase.com/v2/prices/ETH-USD/spot",
    method: "GET",
    headers: {},
    responseResolves: [
      { keyName: "amount", parseType: "json", parsePath: "$.data.amount" },
      { keyName: "base", parseType: "json", parsePath: "$.data.base" },
      { keyName: "currency", parseType: "json", parsePath: "$.data.currency" },
    ],
  });

  console.log("[live-test] Step 2: generating downstream attestation...");
  const llmStep = await builder.addStep({
    stepId: "llm_inference",
    url: "https://api.z.ai/api/paas/v4/chat/completions",
    method: "POST",
    headers: {
      Authorization: `Bearer ${zaiApiKey}`,
      "Content-Type": "application/json",
    },
    bodyBuilder: (prev) => {
      const rawSourceData = prev["data_source"].attestation.attestation.data;
      const amount = prev["data_source"].data["amount"];
      const base = prev["data_source"].data["base"];
      const currency = prev["data_source"].data["currency"];

      return JSON.stringify({
        model: process.env.ZAI_MODEL ?? "glm-5",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Return JSON only: {\"verdict\":\"string\",\"summary\":\"string\"}",
          },
          {
            role: "user",
            content: [
              buildHashReference("data_source", rawSourceData),
              `Observed price: ${amount} ${currency}`,
              `Asset: ${base}`,
              "Summarize this market snapshot in one sentence.",
            ].join("\n"),
          },
        ],
      });
    },
    responseResolves: [
      {
        keyName: "response_text",
        parseType: "json",
        parsePath: "$.choices[0].message.content",
      },
      {
        keyName: "model_used",
        parseType: "json",
        parsePath: "$.model",
      },
    ],
    dependsOn: {
      stepId: "data_source",
      sourceField: "amount",
    },
  });

  const bundle = await builder.build();
  console.log("[live-test] Proof bundle built:", {
    steps: bundle.steps.length,
    chainHash: bundle.chainHash,
    model: llmStep.data["model_used"],
  });

  const hookAddress = resolveNetworkEnv(network, "VERITAS_8183_HOOK_ADDRESS");
  const commerceAddress = resolveNetworkEnv(network, "ERC8183_AGENTIC_COMMERCE_ADDRESS");

  const submitter = new OnChainSubmitter(
    requireEnv("WALLET_PRIVATE_KEY"),
    network,
    rpcUrl,
    {
      VeritasVerifier: veritasVerifierAddress,
      VeritasERC8183Hook: hookAddress,
      ERC8183AgenticCommerce: commerceAddress,
    },
  );

  // ── Verify proof authenticity via VeritasVerifier ──────
  console.log("[live-test] Verifying bundle against deployed VeritasVerifier...");
  const result = await submitter.verifyBundle(
    bundle,
    requireEnv("AGENT_WALLET_ADDRESS"),
  );

  if (!result.verified) {
    throw new Error(`On-chain verification failed: ${result.error}`);
  }
  console.log("[live-test] Proof authenticity: passed");

  // ── Test ERC-8183 hook + evaluator policy flow (if configured) ──
  if (hookAddress) {
    const jobIdRaw = process.env.ERC8183_JOB_ID;
    if (jobIdRaw) {
      const jobId = BigInt(jobIdRaw);
      const validation = await submitter.validateJobSubmission(jobId, bundle);
      if (!validation.verified) {
        throw new Error(`ERC-8183 hook validation failed: ${validation.error}`);
      }
      console.log("[live-test] ERC-8183 hook validation: passed");

      if (commerceAddress && process.env.ERC8183_SUBMIT_LIVE === "true") {
        const submitResult = await submitter.submitJob(jobId, bundle);
        if (!submitResult.verified) {
          throw new Error(`ERC-8183 submit failed: ${submitResult.error}`);
        }
        console.log(`[live-test] ERC-8183 submit: passed. TX: ${submitResult.txHash}`);
      }
    } else {
      console.log("[live-test] ERC8183_JOB_ID not set — skipping hook validation");
    }
  } else {
    console.log("[live-test] VERITAS_8183_HOOK_ADDRESS not set — skipping hook test");
  }

  console.log("[live-test] All tests passed");
}

main().catch((error) => {
  console.error("[live-test] Failed:", error);
  process.exitCode = 1;
});

