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
│  Layer 4: Optional On-chain Verification (Base Chain)        │
│  TrustLayerVerifier.sol ──► IPrimusZKTLS.verifyAttestation   │
│  Used when escrow release should be gated on-chain           │
└───────────────────────────┬──────────────────────────────────┘
                            │ on-chain verification
┌───────────────────────────▼──────────────────────────────────┐
│  Layer 3: Proof Chain Builder (Provider runtime)             │
│  ProofChainBuilder.ts                                        │
│  ├── Step A: HTTPS Attestation (any trusted API endpoint)    │
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
| Provider uses a local fake LLM | Attestation_2 proves request was sent to a trusted inference API such as `api.openai.com` or `api.deepseek.com`, domain whitelist enforced on-chain |
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
│   │   ├── IPrimusZKTLS.sol         # Primus interface
│   │   └── ITrustLayer.sol          # TrustLayer public interface
│   └── libraries/
│       └── ProofParser.sol          # ABI decode helpers
├── sdk/
│   └── index.ts                     # Public SDK exports
├── examples/
│   ├── fact-check/
│   │   ├── provider.ts              # Full ArAIstotle-style example
│   │   └── evaluator.ts             # Buyer-side evaluation example
│   └── generic-api-pipeline/
│       ├── provider.ts              # Generic HTTPS source -> scoring pipeline
│       └── evaluator.ts             # Generic buyer-side verification example
├── docs/
│   ├── ARCHITECTURE.md              # Deep-dive architecture doc
│   ├── INTEGRATION_GUIDE.md         # Provider integration guide
│   └── CONTRACTS.md                 # Contract reference
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

### 3. Verification Options

```solidity
// Optional on-chain verification inside ACP evaluation
TrustLayerVerifier verifier = TrustLayerVerifier(TRUST_LAYER_VERIFIER_BASE);
bool verified = verifier.verifyProofBundle(proofBundle, providerAddress);
require(verified, "TrustLayer: proof chain invalid");
```

You can also verify attestations off-chain with the Primus core-sdk before ever
calling a contract. TrustLayer uses that off-chain verification path during
proof generation already.

---

## Contract Addresses

| Contract | Address |
|---|---|
| TrustLayerVerifier | `pending deployment` |
| TrustLayerACPHook | `pending deployment` |
| Primus verifier (Base) | `unconfirmed in this repo` |

---

## Trusted Domain Whitelist

The on-chain verifier enforces that all attested URLs belong to a whitelist of trusted domains. Initial whitelist:

**Data Sources:** `reuters.com`, `apnews.com`, `sec.gov`, `coindesk.com`, `coingecko.com`, `api.coingecko.com`, `finance.yahoo.com`

**LLM APIs:** `api.openai.com`, `api.deepseek.com`, `api.anthropic.com`, `api.mistral.ai`, `generativelanguage.googleapis.com`

Whitelist governance is managed by the contract owner (Phase 1), with plans for decentralized staking-based governance in Phase 4.

> Note: Off-chain, the SDK can be configured with a custom `trustedDomains` list for early rejection.
> On-chain, `TrustLayerVerifier.sol` remains the final enforcement point.

## Default TLS Mode

TrustLayer defaults to `proxytls`.

Use `mpctls` only when you explicitly set `mode: "mpctls"` for a step and are
comfortable with the additional latency.

---

## Integration Phases

| Phase | Description |
|---|---|
| **Phase 1** (Now) | TrustLayer SDK ships. Providers opt-in. Verified providers get 🛡️ badge on agdp.io |
| **Phase 2** | agdp.io adds `trustLayerEnabled` filter. Buyers can filter for verified providers |
| **Phase 3** | ACP Job contract upgrade: `trustLayerEnabled` providers must pass proof verification for escrow release |
| **Phase 4** | Domain whitelist governance decentralized via staking |

---

## License

MIT
