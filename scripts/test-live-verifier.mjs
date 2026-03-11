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
  const network = process.env.TRUST_LAYER_NETWORK ?? "base_sepolia";
  if (network !== "base_mainnet" && network !== "base_sepolia") {
    throw new Error("TRUST_LAYER_NETWORK must be base_mainnet or base_sepolia");
  }

  const rpcUrl =
    process.env.TRUST_LAYER_RPC_URL ??
    (network === "base_mainnet"
      ? process.env.BASE_RPC_URL
      : process.env.BASE_SEPOLIA_RPC_URL);

  const deepseekApiKey =
    process.env.DEEPSEEK_API_KEY ??
    process.env.OPENAI_API_KEY;
  if (!deepseekApiKey) {
    throw new Error("DEEPSEEK_API_KEY is required");
  }

  const trustLayerVerifierAddress = resolveNetworkEnv(
    network,
    "TRUST_LAYER_VERIFIER_ADDRESS",
  );
  if (!trustLayerVerifierAddress) {
    throw new Error(
      "TRUST_LAYER_VERIFIER_ADDRESS is required. " +
      "You can also set BASE_SEPOLIA_TRUST_LAYER_VERIFIER_ADDRESS or BASE_MAINNET_TRUST_LAYER_VERIFIER_ADDRESS.",
    );
  }

  const builder = new ProofChainBuilder({
    primusAppId: requireEnv("PRIMUS_APP_ID"),
    primusAppSecret: requireEnv("PRIMUS_APP_SECRET"),
    providerWallet: requireEnv("AGENT_WALLET_ADDRESS"),
  });

  console.log("[live-test] Step 1: generating source-data attestation...");
  const sourceStep = await builder.addStep({
    stepId: "source_data",
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
    stepId: "deepseek_inference",
    url: "https://api.deepseek.com/chat/completions",
    method: "POST",
    headers: {
      Authorization: `Bearer ${deepseekApiKey}`,
      "Content-Type": "application/json",
    },
    bodyBuilder: (prev) => {
      const rawSourceData = prev["source_data"].attestation.attestation.data;
      const amount = prev["source_data"].data["amount"];
      const base = prev["source_data"].data["base"];
      const currency = prev["source_data"].data["currency"];

      return JSON.stringify({
        model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
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
              buildHashReference("source_data", rawSourceData),
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
      stepId: "source_data",
      sourceField: "amount",
    },
  });

  const bundle = await builder.build();
  console.log("[live-test] Proof bundle built:", {
    steps: bundle.steps.length,
    chainHash: bundle.chainHash,
    model: llmStep.data["model_used"],
  });

  const submitter = new OnChainSubmitter(
    requireEnv("WALLET_PRIVATE_KEY"),
    network,
    rpcUrl,
    {
      TrustLayerVerifier: trustLayerVerifierAddress,
      TrustLayerACPHook: resolveNetworkEnv(network, "TRUST_LAYER_ACP_HOOK_ADDRESS"),
    },
  );

  console.log("[live-test] Verifying bundle against deployed TrustLayerVerifier...");
  const result = await submitter.verifyBundle(
    bundle,
    requireEnv("AGENT_WALLET_ADDRESS"),
  );

  if (!result.verified) {
    throw new Error(`On-chain verification failed: ${result.error}`);
  }

  console.log("[live-test] Success: on-chain verification passed");
}

main().catch((error) => {
  console.error("[live-test] Failed:", error);
  process.exitCode = 1;
});

