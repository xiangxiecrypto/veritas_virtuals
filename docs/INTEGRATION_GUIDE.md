# TrustLayer — Provider Integration Guide

## Overview

This guide shows how to integrate TrustLayer into an existing Virtuals ACP
Provider so the Provider can prove that its deliverable came from a real
sequence of HTTPS API calls.

TrustLayer is **not specific to fact-checking or OpenAI**. Any pipeline like the
following can be wrapped:

```text
Step 1: GET  https://api.source.com/data        -> verified source data
Step 2: POST https://api.service.com/transform  -> verified downstream result
Step 3: POST https://api.model.com/analyze      -> verified final output
```

The main rule is simple:

- each step is an attested HTTPS call
- each downstream step can cryptographically depend on an earlier step
- the final `proofBundle` is attached to the ACP deliverable

In the `zktls-core-sdk` enterprise model:

- attestation generation happens off-chain in your runtime
- attestation verification can also happen off-chain in the SDK
- on-chain verification is optional and only needed when the blockchain itself
  must enforce the result

Integration usually takes about 30 minutes.

---

## Prerequisites

- Node.js 18+
- A registered ACP agent on `app.virtuals.io/acp`
- A Primus account at `dev.primuslabs.xyz`
- Your agent uses `@virtuals-protocol/acp-node`

---

## Step 1: Install

```bash
npm install @trust-layer/sdk
```

TrustLayer uses Primus's `@primuslabs/zktls-core-sdk` under the hood when it
generates attestations off-chain.

---

## Step 2: Get Primus Credentials

1. Go to [dev.primuslabs.xyz](https://dev.primuslabs.xyz)
2. Create a project
3. Copy your `appID` and `appSecret`
4. Add them to your environment:

```env
PRIMUS_APP_ID=your_app_id
PRIMUS_APP_SECRET=your_app_secret
```

---

## Step 3: Identify Your HTTPS Call Chain

Map out the real HTTPS requests your Provider makes before it produces a final
deliverable.

Example generic pipeline:

```text
Step 1: GET  https://api.marketdata.com/v1/price
Step 2: POST https://api.risk-engine.com/v1/score
Step 3: POST https://api.model.com/v1/analyze
```

Each of these becomes a `builder.addStep()` call.

If step 2 uses data from step 1, or step 3 uses data from step 2, include the
relevant upstream hash in the request body using `buildHashReference()`.

---

## Step 4: Wrap Your Logic with `ProofChainBuilder`

### Before (no TrustLayer)

```typescript
async function handleJob(job: AcpJob) {
  const sourceResp = await fetch("https://api.marketdata.com/v1/price");
  const sourceJson = await sourceResp.json();

  const scoreResp = await fetch("https://api.risk-engine.com/v1/score", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      symbol: sourceJson.symbol,
      price: sourceJson.price,
    }),
  });

  const scoreJson = await scoreResp.json();
  await job.deliver(JSON.stringify({ score: scoreJson.score }));
}
```

### After (with TrustLayer)

```typescript
import { ProofChainBuilder, buildHashReference } from "@trust-layer/sdk";

async function handleJob(job: AcpJob) {
  const builder = new ProofChainBuilder({
    primusAppId: process.env.PRIMUS_APP_ID!,
    primusAppSecret: process.env.PRIMUS_APP_SECRET!,
    providerWallet: process.env.AGENT_WALLET_ADDRESS!,
  });

  const sourceStep = await builder.addStep({
    stepId: "source_data",
    url: "https://api.marketdata.com/v1/price",
    method: "GET",
    headers: {},
    responseResolves: [
      { keyName: "symbol", parseType: "json", parsePath: "$.symbol" },
      { keyName: "price", parseType: "json", parsePath: "$.price" },
    ],
    // mode omitted -> defaults to proxytls
  });

  const scoringStep = await builder.addStep({
    stepId: "risk_score",
    url: "https://api.risk-engine.com/v1/score",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    bodyBuilder: (prev) => {
      const symbol = prev["source_data"].data["symbol"];
      const price = prev["source_data"].data["price"];
      const priceAnchor = buildHashReference("source_data", price);

      return JSON.stringify({
        symbol,
        price,
        evidence: priceAnchor,
      });
    },
    responseResolves: [
      { keyName: "score", parseType: "json", parsePath: "$.score" },
      { keyName: "band", parseType: "json", parsePath: "$.band" },
    ],
    dependsOn: { stepId: "source_data", sourceField: "price" },
  });

  const proofBundle = await builder.build();

  await job.deliver(JSON.stringify({
    score: scoringStep.data["score"],
    band: scoringStep.data["band"],
    proofBundle,
  }));
}
```

---

## Step 5: Default TLS Mode

TrustLayer now defaults to **`proxytls`**.

That means:

- you do **not** need to set `mode` for most steps
- the SDK will automatically use `proxytls`
- you only set `mode: "mpctls"` when you explicitly want it

Practical recommendation:

- use default `proxytls` for almost all ACP workloads
- consider `mpctls` only for rare, highly sensitive authenticated requests

Example of explicit override:

```typescript
await builder.addStep({
  stepId: "sensitive_call",
  url: "https://api.example.com/private",
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.API_KEY}` },
  responseResolves: [
    { keyName: "value", parseType: "json", parsePath: "$.value" },
  ],
  mode: "mpctls",
});
```

---

## Step 6: Optional Off-chain Domain Policy

The SDK can reject domains early before a request is sent to Primus.

```typescript
const builder = new ProofChainBuilder({
  primusAppId: process.env.PRIMUS_APP_ID!,
  primusAppSecret: process.env.PRIMUS_APP_SECRET!,
  providerWallet: process.env.AGENT_WALLET_ADDRESS!,
  trustedDomains: [
    "api.marketdata.com",
    "api.risk-engine.com",
    "api.model.com",
  ],
});
```

Important:

- this off-chain allowlist is a convenience and safety layer
- the **on-chain verifier whitelist remains the final enforcement point**

---

## Step 7: Verification Choices

### Option A: Off-chain Verification Only

This is the default enterprise/core-sdk setup.

- the Provider generates the proof off-chain
- the SDK validates it off-chain with `verifyAttestation()`
- a Buyer or Evaluator can repeat the same off-chain verification
- no contract call is required unless your workflow wants one

### Option B: Optional On-chain Verification

Use this when escrow release or another contract-level action should depend on
proof verification.

- proof generation still happens off-chain
- the proof is later verified on-chain by TrustLayer contracts

---

## Step 8: Update Your Job Offering Description

Signal to Buyers that your service includes TrustLayer proofs:

```typescript
{
  name: "Verified Data Analysis",
  description:
    "Verifiable HTTPS API pipeline with TrustLayer cryptographic proofs.",
  price: 1.0,
  sla: 20,
  deliverables: "JSON: { result, proofBundle }",
}
```

Because `proxytls` is the default, most workloads only need a modest SLA bump.

---

## Step 9: Register with `TrustLayerACPHook` (Optional, Phase 3)

Once the hook contract is deployed, opt in to optional on-chain enforcement:

```typescript
import { OnChainSubmitter } from "@trust-layer/sdk";

const submitter = new OnChainSubmitter(
  process.env.WALLET_PRIVATE_KEY!,
  "base_mainnet",
);

// One-time setup is performed via TrustLayerACPHook.registerProvider()
```

---

## SLA Considerations

Typical overhead:

| Step Type | Additional Latency |
|---|---|
| `proxytls` HTTPS call | +2–5 seconds |
| `mpctls` HTTPS call | +5–15 seconds |

For most ACP jobs, defaulting to `proxytls` is the most practical choice.

---

## Supported Domains

Each step's `url` must resolve to a domain accepted by TrustLayer policy.

- SDK side: optional early rejection via `trustedDomains`
- Contract side: final whitelist enforcement on-chain

See [README.md](../README.md#trusted-domain-whitelist) for the default list.

---

## Debugging

### `TrustLayerError: CHAIN_LINKAGE_BROKEN`

Your downstream request body does not include the expected upstream hash.
Use `buildHashReference(stepId, value)` inside `bodyBuilder()`.

### `TrustLayerError: UNTRUSTED_DOMAIN`

The URL is not accepted by the configured policy.
Either add it to your off-chain `trustedDomains` config or get it added to the
on-chain whitelist.

### `TrustLayerError: RECIPIENT_MISMATCH`

The `providerWallet` in `ProofChainBuilderConfig` does not match the actual
wallet that should own the proof.

### `TrustLayerError: PRIMUS_INIT_FAILED`

Check:

- `PRIMUS_APP_ID`
- `PRIMUS_APP_SECRET`
- your Primus project status
- that the runtime environment can load `@primuslabs/zktls-core-sdk`
