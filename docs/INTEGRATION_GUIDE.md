# TrustLayer — Provider Integration Guide

## Overview

This guide walks you through integrating TrustLayer into an existing
Virtuals ACP Provider agent. Integration takes about 30 minutes.

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

---

## Step 2: Get Primus Credentials

1. Go to [dev.primuslabs.xyz](https://dev.primuslabs.xyz)
2. Create a new project
3. Copy your `appID` and `appSecret`
4. Add to your `.env`:

```env
PRIMUS_APP_ID=your_app_id
PRIMUS_APP_SECRET=your_app_secret
```

---

## Step 3: Identify Your API Call Chain

Map out the HTTPS calls your agent makes to produce a result.
For a typical AI service agent:

```
Request Chain:
  Step 1: GET  https://data-source.com/api     → raw data
  Step 2: POST https://api.openai.com/v1/...   → AI result (using Step 1 data)
```

Each step in this chain becomes a `ProofChainBuilder.addStep()` call.

---

## Step 4: Wrap Your Logic with ProofChainBuilder

### Before (no TrustLayer)

```typescript
async function handleJob(job: AcpJob) {
  const data = await fetch("https://reuters.com/api/search?q=" + claim);
  const article = await data.json();

  const llmResponse = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: article.body + "\n\nFact check: " + claim }]
  });

  await job.deliver(JSON.stringify({ verdict: llmResponse.choices[0].message.content }));
}
```

### After (with TrustLayer)

```typescript
import { ProofChainBuilder, buildHashReference } from "@trust-layer/sdk";

async function handleJob(job: AcpJob) {
  const builder = new ProofChainBuilder({
    primusAppId:     process.env.PRIMUS_APP_ID!,
    primusAppSecret: process.env.PRIMUS_APP_SECRET!,
    providerWallet:  process.env.AGENT_WALLET_ADDRESS!,
  });

  // Step 1: same fetch, but now proven
  const step1 = await builder.addStep({
    stepId: "data_source",
    url: "https://reuters.com/api/search?q=" + encodeURIComponent(claim),
    method: "GET",
    headers: {},
    responseResolves: [
      { keyName: "article_body", parseType: "json", parsePath: "$.results[0].body" }
    ],
    mode: "proxytls",
  });

  // Step 2: LLM call, referencing step 1 data by hash
  const step2 = await builder.addStep({
    stepId: "llm_inference",
    url: "https://api.openai.com/v1/chat/completions",
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
    bodyBuilder: (prev) => {
      const content = prev["data_source"].data["article_body"];
      return JSON.stringify({
        model: "gpt-4o",
        messages: [{
          role: "user",
          // buildHashReference embeds SHA256 anchor — required for chain linkage
          content: `${buildHashReference("data_source", content)}\n${content}\n\nFact check: ${claim}`
        }]
      });
    },
    responseResolves: [
      { keyName: "verdict", parseType: "json", parsePath: "$.choices[0].message.content.verdict" }
    ],
    mode: "mpctls",
    dependsOn: { stepId: "data_source", sourceField: "article_body" },
  });

  // Build bundle and deliver
  const proofBundle = await builder.build();
  await job.deliver(JSON.stringify({
    verdict: step2.data["verdict"],
    proofBundle,  // Attach proof bundle to deliverable
  }));
}
```

---

## Step 5: Update Your Job Offering Description

Signal to Buyers that your service includes TrustLayer proofs:

```typescript
// In your job offering registration
{
  name: "Fact Check",
  description: "Verifiable fact-checking with TrustLayer cryptographic proofs. " +
               "Includes zkTLS attestations for data sources and LLM inference.",
  price: 1.00,
  sla: 10,  // Allow extra time for zkTLS attestation (~5-15 sec overhead)
  deliverables: "JSON: { verdict, score, summary, sources, proofBundle }"
}
```

---

## Step 6: Register with TrustLayerACPHook (Optional, Phase 3)

Once the hook contract is deployed, opt in to on-chain enforcement:

```typescript
import { OnChainSubmitter } from "@trust-layer/sdk";

const submitter = new OnChainSubmitter(process.env.WALLET_PRIVATE_KEY!, "base_mainnet");
// Call ACPHook.registerProvider() — one-time setup
```

---

## SLA Considerations

TrustLayer adds latency to each API call. Typical overhead:

| Step Type | Additional Latency |
|---|---|
| `proxytls` data fetch | +2–5 seconds |
| `mpctls` LLM call | +5–15 seconds |

Increase your Job Offering `sla` accordingly. For a 2-step proof chain,
add ~20 seconds to your normal SLA.

---

## Supported Domains

Your `url` in each step must be in the trusted domain whitelist.
See [README.md](../README.md#trusted-domain-whitelist) for the full list.

To request a new domain be added, open a GitHub issue.

---

## Debugging

### `TrustLayerError: CHAIN_LINKAGE_BROKEN`

Your `bodyBuilder` doesn't include the hash reference from the parent step.
Make sure to call `buildHashReference(stepId, content)` and include the
result in the body string.

### `TrustLayerError: UNTRUSTED_DOMAIN`

The URL you're trying to attest is not in the whitelist. Either use a
whitelisted URL or open an issue to add your domain.

### `TrustLayerError: RECIPIENT_MISMATCH`

The `providerWallet` in your `ProofChainBuilderConfig` doesn't match your
actual agent wallet address. Check `AGENT_WALLET_ADDRESS` in your `.env`.

### Primus SDK Errors

Make sure your `PRIMUS_APP_ID` and `PRIMUS_APP_SECRET` are correct and your
Primus project is active at `dev.primuslabs.xyz`.
