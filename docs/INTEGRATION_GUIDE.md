# Veritas — Integration Guide

## Overview

This guide shows the current integration path for Veritas with ERC-8183.

Use Veritas when a provider workflow looks like:

1. call one or more real HTTPS APIs
2. optionally feed verified output into later API calls
3. produce a final application result
4. prove on-chain that the result came from that verified workflow

## Prerequisites

- Node.js 18+
- Primus project credentials
- provider wallet
- evaluator wallet
- deployed ERC-8183 `AgenticCommerce`
- optional deployed policy contract

## Environment

```env
PRIMUS_APP_ID=...
PRIMUS_APP_SECRET=...

WALLET_PRIVATE_KEY=0x...
AGENT_WALLET_ADDRESS=0x...
BUYER_PRIVATE_KEY=0x...

VERITAS_NETWORK=base_sepolia
VERITAS_RPC_URL=
PRIMUS_VERIFIER_ADDRESS=0xCE7cefB3B5A7eB44B59F60327A53c9Ce53B0afdE

VERITAS_VERIFIER_ADDRESS=0x...
VERITAS_8183_HOOK_ADDRESS=0x...
ERC8183_AGENTIC_COMMERCE_ADDRESS=0x...

EVALUATOR_ADDRESS=0x...
POLICY_CONTRACT=FactCheckPolicy
POLICY_MAX_AGE_SECS=600
POLICY_TRUSTED_DOMAINS=reuters.com,api.z.ai
```

## Step 1: Build a Proof Chain

Wrap your real HTTPS calls in `ProofChainBuilder`.

```typescript
import { ProofChainBuilder, buildHashReference } from "@veritas/sdk";

const builder = new ProofChainBuilder({
  primusAppId: process.env.PRIMUS_APP_ID!,
  primusAppSecret: process.env.PRIMUS_APP_SECRET!,
  providerWallet: process.env.AGENT_WALLET_ADDRESS!,
});

const sourceStep = await builder.addStep({
  stepId: "data_source",
  url: "https://api.example.com/data",
  method: "GET",
  headers: {},
  responseResolves: [
    { keyName: "value", parseType: "json", parsePath: "$.value" },
  ],
});

const llmStep = await builder.addStep({
  stepId: "llm_inference",
  url: "https://api.z.ai/api/paas/v4/chat/completions",
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.ZAI_API_KEY}`,
    "Content-Type": "application/json",
  },
  bodyBuilder: (prev) => JSON.stringify({
    model: "glm-5",
    messages: [{
      role: "user",
      content: [
        buildHashReference("data_source", prev["data_source"].attestation.attestation.data),
        `Observed value: ${prev["data_source"].data["value"]}`,
      ].join("\n"),
    }],
  }),
  responseResolves: [
    { keyName: "result", parseType: "json", parsePath: "$.choices[0].message.content" },
  ],
  dependsOn: {
    stepId: "data_source",
    sourceField: "value",
  },
});

const proofBundle = await builder.build();
```

## Step 2: Build the Application Deliverable

Your application-level result can be any JSON shape.

```typescript
const deliverable = {
  result: llmStep.data["result"],
  proofBundle,
};
```

The important ERC-8183 rule is not the JSON shape itself. The important rule is
how you map the bundle into the on-chain submission:

- `deliverable` argument for ERC-8183 `submit()` must equal `proofBundle.chainHash`
- `optParams` must contain the ABI-encoded proof bundle

## Step 3: Deploy Veritas Contracts

Compile and deploy:

```bash
npm run compile:contracts
npm run deploy:contracts
```

This deploys:

- `VeritasVerifier`
- `VeritasERC8183Hook`

The deploy script expects `ERC8183_AGENTIC_COMMERCE_ADDRESS`.

## Step 4: Deploy an Evaluator Policy

If you need business-specific on-chain rules, deploy a policy:

```bash
npm run deploy:policy
```

Examples already included:

- `FactCheckPolicy`
- `TokenAnalysisPolicy`

## Step 5: Register the Policy on the Hook

Evaluator-side:

```typescript
import { OnChainSubmitter } from "@veritas/sdk";

const submitter = new OnChainSubmitter(
  process.env.BUYER_PRIVATE_KEY!,
  "base_sepolia",
  undefined,
  {
    VeritasERC8183Hook: process.env.VERITAS_8183_HOOK_ADDRESS,
  },
);

await submitter.setPolicy(policyAddress);
```

## Step 6: Prepare the ERC-8183 Submission Payload

Provider-side:

```typescript
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

const prepared = submitter.prepareJobSubmission(proofBundle);
```

`prepared` contains:

- `deliverable = proofBundle.chainHash`
- `optParams = abi.encode(proofBundle)`

## Step 7: Dry-run Validation

Before spending gas, validate exactly what the hook will check:

```typescript
const validation = await submitter.validateJobSubmission(jobId, proofBundle);
if (!validation.verified) {
  throw new Error(validation.error);
}
```

This runs the same proof + policy logic used in the hook during `submit()`.

## Step 8: Submit the Job

Provider-side:

```typescript
const result = await submitter.submitJob(jobId, proofBundle);
if (!result.verified) {
  throw new Error(result.error);
}
console.log(result.txHash);
```

## Step 9: Complete the Job

Evaluator-side:

```typescript
const evaluatorSubmitter = new OnChainSubmitter(
  process.env.BUYER_PRIVATE_KEY!,
  "base_sepolia",
  undefined,
  {
    VeritasERC8183Hook: process.env.VERITAS_8183_HOOK_ADDRESS,
    ERC8183AgenticCommerce: process.env.ERC8183_AGENTIC_COMMERCE_ADDRESS,
  },
);

const txHash = await evaluatorSubmitter.completeJob(
  jobId,
  "Verified by Veritas",
);
```

The hook blocks completion if the job has not already passed Veritas
verification.

## Domain Policy

There is no global verifier-level whitelist.

Recommended rule:

- use SDK `trustedDomains` only for convenience
- use `IEvaluatorPolicy` for authoritative on-chain domain enforcement

## TLS Mode

Default mode is `proxytls`.

Only use `mpctls` when you explicitly need it for a specific step.

## Common Errors

### `provider wallet mismatch`

The bundle recipient/provider does not match the ERC-8183 job provider.

### `deliverable must equal bundle chainHash`

You passed the wrong on-chain `deliverable` value. Use `prepareJobSubmission()`
or `submitJob()`.

### `evaluator policy rejected`

The bundle is authentic but violates the evaluator's workflow rules.

### `attestation too old`

The verifier freshness window expired. Generate a new bundle.

## Example Files

- `examples/fact-check/provider.ts`
- `examples/fact-check/evaluator.ts`
- `examples/generic-api-pipeline/provider.ts`
- `examples/generic-api-pipeline/evaluator.ts`
- `examples/token-analysis/provider.ts`
- `examples/token-analysis/evaluator.ts`
