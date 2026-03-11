# TrustLayer

> A verifiable proof layer for Virtuals ACP — powered by Primus zkTLS

TrustLayer is a cryptographic middleware that allows ACP Providers to **prove** to Buyers that a sequence of **HTTPS API calls** actually happened as claimed, and that outputs of later calls were derived from earlier verified responses.

1. They actually fetched data from a specific real-world HTTPS endpoint (e.g. Reuters, SEC, CoinGecko)
2. They fed that **exact, unmodified** data into a subsequent HTTPS call (often an LLM API, but not limited to OpenAI)
3. The final output in their Deliverable Memo is **genuinely what the attested API returned** — not fabricated

Every step is attested **off-chain** using [Primus zkTLS](https://primuslabs.xyz) via `@primuslabs/zktls-core-sdk`. The resulting attestation can be verified off-chain in the SDK, and can also be verified on-chain when ACP escrow release needs an on-chain guarantee.

---

## The Problem

In Virtuals ACP, a Provider submits a `Deliverable Memo` — but nothing in the protocol prevents them from fabricating the result. A Fact Check agent could return `{"verdict":"True","score":95}` without ever calling a real data source or LLM. The escrow would still release.

TrustLayer fixes this at the **cryptographic layer**, not at the reputation layer.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Layer 5: Evaluator Policy Contracts (IEvaluatorPolicy)      │
│  Each evaluator deploys custom Solidity logic.               │
│  TrustLayerACPHook calls policy.check() automatically.       │
└───────────────────────────┬──────────────────────────────────┘
                            │ fully automated evaluation
┌───────────────────────────▼──────────────────────────────────┐
│  Layer 4: On-chain Verification (Base Chain)                 │
│  TrustLayerVerifier.sol ──► IPrimusZKTLS.verifyAttestation   │
│  TrustLayerACPHook.sol ──► proof check + policy.check()      │
└───────────────────────────┬──────────────────────────────────┘
                            │ on-chain verification
┌───────────────────────────▼──────────────────────────────────┐
│  Layer 3: Proof Chain Builder (Provider runtime)             │
│  ProofChainBuilder.ts                                        │
│  ├── Step A: HTTPS Attestation (any HTTPS API endpoint)      │
│  ├── Step B: HTTPS Attestation (often an LLM, but general)   │
│  └── Linkage: SHA256(stepA.data) ∈ stepB.request.body        │
└───────────────────────────┬──────────────────────────────────┘
                            │ multi-URL aggregated attestation
┌───────────────────────────▼──────────────────────────────────┐
│  Layer 2: Primus Enterprise Core-SDK                         │
│  @primuslabs/zktls-core-sdk                                  │
│  ├── Attestation generation happens off-chain                │
│  ├── Proxy-TLS mode — default, better production latency     │
│  └── MPC-TLS mode  — optional for rare sensitive requests    │
└───────────────────────────┬──────────────────────────────────┘
                            │ TLS session witnessing
┌───────────────────────────▼──────────────────────────────────┐
│  Layer 1: External APIs                                      │
│  reuters.com / sec.gov / api.openai.com / api.deepseek.com / api.anthropic.com │
└──────────────────────────────────────────────────────────────┘
```

### What TrustLayer Proves vs Cannot Prove

| Threat | TrustLayer Defence |
|---|---|
| Provider fabricates data source | Attestation_1 cryptographically proves HTTP response came from a real domain |
| Provider tampers data before sending to LLM | Attestation_2 body must contain SHA256(Attestation_1.data) — tampering breaks the hash |
| Provider uses a local fake LLM | Attestation_2 proves request was sent to a real HTTPS endpoint; evaluator's policy contract enforces allowed domains on-chain |
| Provider replays an old proof | Timestamp check: attestation must be within the Job SLA window |
| Provider forges an attestation locally | SDK/off-chain verification and optional on-chain verification both reject invalid attestations |
| Provider swaps recipient address | Contract verifies `recipient == provider wallet address` |
| LLM hallucination | ❌ Out of scope — this is a model-layer problem, not an engineering problem |

---

## Repository Structure

```
trust-layer/
├── src/
│   ├── core/
│   │   ├── ProofChainBuilder.ts     # Main SDK entry point
│   │   └── StepProver.ts            # Single-step zkTLS prover
│   ├── chain/
│   │   └── OnChainSubmitter.ts      # Submit proof bundle to Base
│   ├── types/
│   │   └── index.ts                 # All TypeScript types
│   └── utils/
│       ├── hash.ts                  # SHA256 / chain hash utilities
│       └── domain.ts                # Domain extraction & validation
├── contracts/
│   ├── TrustLayerVerifier.sol       # Core on-chain verifier
│   ├── TrustLayerACPHook.sol        # ACP Job integration hook
│   ├── interfaces/
│   │   ├── IPrimusZKTLS.sol         # Primus attestation interface
│   │   ├── ITrustLayer.sol          # TrustLayer public interface
│   │   └── IEvaluatorPolicy.sol     # Evaluator policy interface
│   ├── policies/
│   │   └── FactCheckPolicy.sol      # Reference evaluator policy
│   └── libraries/
│       └── ProofParser.sol          # ABI decode helpers
├── examples/
│   ├── fact-check/
│   │   ├── provider.ts              # Full ArAIstotle-style example
│   │   └── evaluator.ts             # Buyer-side evaluation example
│   └── generic-api-pipeline/
│       ├── provider.ts              # Generic HTTPS source -> scoring pipeline
│       └── evaluator.ts             # Generic buyer-side verification example
├── docs/
│   ├── ARCHITECTURE.md              # Deep-dive architecture doc
│   └── INTEGRATION_GUIDE.md         # Provider & evaluator integration guide
├── package.json
├── tsconfig.json
└── .env.example
```

---

## Quick Start

### 1. Install

```bash
npm install @trust-layer/sdk
```

### 2. Provider: Generate a Proof Chain

```typescript
import { ProofChainBuilder } from "@trust-layer/sdk";

const builder = new ProofChainBuilder({
  primusAppId: process.env.PRIMUS_APP_ID!,
  primusAppSecret: process.env.PRIMUS_APP_SECRET!,
  providerWallet: process.env.PROVIDER_WALLET!,
});

// Step 1: Prove you fetched real data from a trusted HTTPS API
await builder.addStep({
  stepId: "data_source",
  url: "https://reuters.com/api/search?q=tesla+robotaxi",
  method: "GET",
  headers: {},
  responseResolves: [
    { keyName: "article_content", parseType: "json", parsePath: "$.results[0].body" }
  ],
  // mode omitted -> defaults to proxytls
});

// Step 2: Prove you called a real downstream HTTPS API (often an LLM) with that exact data
await builder.addStep({
  stepId: "downstream_call",
  url: "https://api.deepseek.com/chat/completions",
  method: "POST",
  headers: { "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}` },
  bodyBuilder: (prevSteps) => {
    const content = prevSteps["data_source"].data["article_content"];
    return JSON.stringify({
      model: "gpt-4o",
      messages: [{
        role: "user",
        // Embed SHA256(content) in the body — creates cryptographic linkage
        content: `[source_hash:data_source:${prevSteps["data_source"].dataHash}]\n${content}\n\nAnalyze: tesla robotaxi 2025`
      }],
      seed: 42,
    });
  },
  responseResolves: [
    { keyName: "result", parseType: "json", parsePath: "$.choices[0].message.content" },
    { keyName: "model",   parseType: "json", parsePath: "$.model" }
  ],
  dependsOn: { stepId: "data_source", sourceField: "article_content" }, // Enforces chain linkage verification
});

const proofBundle = await builder.build();

// Attach to ACP Deliverable Memo
await job.deliver(JSON.stringify({
  verdict: "Partially True",
  score: 62,
  proofBundle,   // <-- TrustLayer proof chain
}));
```

### 3. Evaluator: Deploy a Policy Contract (one-time)

Each evaluator deploys their own `IEvaluatorPolicy` contract with arbitrary
Solidity verification logic, then registers it on the hook:

```solidity
// Example: FactCheckPolicy — requires data_source + llm_inference steps
contract FactCheckPolicy is IEvaluatorPolicy {
    function check(
        ITrustLayer.ProofBundle calldata bundle,
        address provider
    ) external view returns (bool) {
        require(bundle.steps.length >= 2, "need 2 steps");
        // ... any custom business logic ...
        return true;
    }
}
```

```typescript
import { OnChainSubmitter } from "@trust-layer/sdk";

const submitter = new OnChainSubmitter(privateKey, "base_sepolia", undefined, {
  TrustLayerACPHook: hookAddress,
});

// One-time: point evaluator to the deployed policy contract
await submitter.setPolicy(factCheckPolicyAddress);
```

After `setPolicy()`, all `verifyDeliverable()` calls for this evaluator are
fully automated — the hook checks proof authenticity and calls `policy.check()`.

### 4. On-chain Verification Flow

```
verifyDeliverable(jobId, provider, evaluator, bundle)
  ├─ TrustLayerVerifier.verifyProofBundle(bundle, provider)   // proof authenticity
  ├─ IEvaluatorPolicy(evaluator).check(bundle, provider)      // business logic
  └─ cache result → escrow can release
```

You can also verify attestations off-chain with the Primus core-sdk before ever
calling a contract. TrustLayer uses that off-chain verification path during
proof generation already.

### 5. Reference Policy Contracts

| Policy Contract | Use Case |
|---|---|
| `FactCheckPolicy.sol` | 2-step fact-check (data_source + llm_inference), domain whitelist, freshness |
| *(your custom policy)* | Any Solidity logic: step counts, domains, cross-step data, scoring |

See `contracts/policies/` for reference implementations.

---

## Contract Addresses

| Contract | Address |
|---|---|
| TrustLayerVerifier | `pending deployment` |
| TrustLayerACPHook | `pending deployment` |
| Primus verifier (Base) | `unconfirmed in this repo` |

---

## Domain Policy

TrustLayer supports **any HTTPS API**. There is no global domain whitelist at the
verifier level.

Domain restrictions are a **business rule** managed by each evaluator in their
`IEvaluatorPolicy` contract. For example, `FactCheckPolicy.sol` maintains its
own domain whitelist and checks every step's URL against it.

> **Off-chain**: The SDK accepts an optional `trustedDomains` set in
> `ProofChainBuilderConfig` for early rejection of typos. If omitted, all
> domains are allowed at the SDK level.
>
> **On-chain**: Each evaluator's policy contract decides which domains are
> acceptable for their use case.

## Default TLS Mode

TrustLayer defaults to `proxytls`.

Use `mpctls` only when you explicitly set `mode: "mpctls"` for a step and are
comfortable with the additional latency.

---

## Integration Phases

| Phase | Description |
|---|---|
| **Phase 1** (Now) | TrustLayer SDK + contracts deployed independently. Providers opt-in by calling `registerProvider()`. No changes to ACP contracts required |
| **Phase 2** | Evaluators deploy `IEvaluatorPolicy` contracts and call `setPolicy()`. Verification is fully automated on-chain — proof authenticity + business rules enforced in a single tx |
| **Phase 3** | Ecosystem adoption: more evaluator policies, more providers, community-contributed policy templates |

---

## License

MIT
