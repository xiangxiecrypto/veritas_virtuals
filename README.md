# TrustLayer

> A verifiable proof layer for Virtuals ACP — powered by Primus zkTLS

TrustLayer is a cryptographic middleware that allows ACP Providers to **prove** to Buyers (and on-chain contracts) that:

1. They actually fetched data from a specific real-world HTTPS endpoint (e.g. Reuters, SEC, CoinGecko)
2. They fed that **exact, unmodified** data into a specific LLM API (e.g. GPT-4o on `api.openai.com`)
3. The LLM output in their Deliverable Memo is **genuinely what the LLM returned** — not fabricated

Every step is attested using [Primus zkTLS](https://primuslabs.xyz), runs inside Phala TEE hardware, and is verified on-chain on Base mainnet before the ACP escrow releases funds.

---

## The Problem

In Virtuals ACP, a Provider submits a `Deliverable Memo` — but nothing in the protocol prevents them from fabricating the result. A Fact Check agent could return `{"verdict":"True","score":95}` without ever calling a real data source or LLM. The escrow would still release.

TrustLayer fixes this at the **cryptographic layer**, not at the reputation layer.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Layer 4: ACP Contract Layer (Base Chain)                    │
│  TrustLayerVerifier.sol ──► IPrimusZKTLS.verifyAttestation   │
│  Escrow release gated on: proof chain verified ✅            │
└───────────────────────────┬──────────────────────────────────┘
                            │ on-chain verification
┌───────────────────────────▼──────────────────────────────────┐
│  Layer 3: Proof Chain Builder (Provider runtime)             │
│  ProofChainBuilder.ts                                        │
│  ├── Step A: Data Source Attestation  (reuters, sec, ...)    │
│  ├── Step B: LLM Inference Attestation (api.openai.com)      │
│  └── Linkage: SHA256(responseA) ∈ requestB.body             │
└───────────────────────────┬──────────────────────────────────┘
                            │ multi-URL aggregated attestation
┌───────────────────────────▼──────────────────────────────────┐
│  Layer 2: Primus zkTLS Layer                                 │
│  @primuslabs/network-core-sdk                                │
│  ├── MPC-TLS mode  — high security (LLM API calls)          │
│  └── Proxy-TLS mode — high throughput (data source fetches) │
└───────────────────────────┬──────────────────────────────────┘
                            │ TLS session witnessing
┌───────────────────────────▼──────────────────────────────────┐
│  Layer 1: External APIs                                      │
│  reuters.com / sec.gov / api.openai.com / api.anthropic.com  │
└──────────────────────────────────────────────────────────────┘
```

### What TrustLayer Proves vs Cannot Prove

| Threat | TrustLayer Defence |
|---|---|
| Provider fabricates data source | Attestation_1 cryptographically proves HTTP response came from a real domain |
| Provider tampers data before sending to LLM | Attestation_2 body must contain SHA256(Attestation_1.data) — tampering breaks the hash |
| Provider uses a local fake LLM | Attestation_2 proves request was sent to `api.openai.com`, domain whitelist enforced on-chain |
| Provider replays an old proof | Timestamp check: attestation must be within the Job SLA window |
| Provider colludes with Primus attestor | Primus Attestors run inside Phala TEE — hardware-level isolation |
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
│   └── fact-check/
│       ├── provider.ts              # Full ArAIstotle-style example
│       └── evaluator.ts             # Buyer-side evaluation example
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

// Step 1: Prove you fetched real data
await builder.addStep({
  stepId: "data_source",
  url: "https://reuters.com/api/search?q=tesla+robotaxi",
  method: "GET",
  headers: {},
  responseResolves: [
    { keyName: "article_content", parseType: "json", parsePath: "$.results[0].body" }
  ],
  mode: "proxytls",
});

// Step 2: Prove you called a real LLM with that data
await builder.addStep({
  stepId: "llm_inference",
  url: "https://api.openai.com/v1/chat/completions",
  method: "POST",
  headers: { "Authorization": `Bearer ${process.env.OPENAI_KEY}` },
  bodyBuilder: (prevSteps) => JSON.stringify({
    model: "gpt-4o",
    messages: [{
      role: "user",
      // Hash of previous step's data is embedded — creates cryptographic linkage
      content: `[source_hash:${prevSteps["data_source"].dataHash}]\n${prevSteps["data_source"].data}\n\nFact check: tesla robotaxi 2025`
    }],
    seed: 42,
  }),
  responseResolves: [
    { keyName: "verdict", parseType: "json", parsePath: "$.choices[0].message.content.verdict" },
    { keyName: "model",   parseType: "json", parsePath: "$.model" }
  ],
  mode: "mpctls",             // Higher security for API key protection
  dependsOn: "data_source",   // Enforces chain linkage verification
});

const proofBundle = await builder.build();

// Attach to ACP Deliverable Memo
await job.deliver(JSON.stringify({
  verdict: "Partially True",
  score: 62,
  proofBundle,   // <-- TrustLayer proof chain
}));
```

### 3. On-chain Verification (inside ACP evaluator)

```solidity
TrustLayerVerifier verifier = TrustLayerVerifier(TRUST_LAYER_VERIFIER_BASE);
bool verified = verifier.verifyProofBundle(proofBundle, providerAddress);
require(verified, "TrustLayer: proof chain invalid");
```

---

## Contract Addresses (Base Mainnet)

| Contract | Address |
|---|---|
| TrustLayerVerifier | `pending deployment` |
| TrustLayerACPHook | `pending deployment` |
| Primus zkTLS (Base) | `0xCE7cefB3B5A7eB44B59F60327A53c9Ce53B0afdE` |

---

## Trusted Domain Whitelist

The on-chain verifier enforces that all attested URLs belong to a whitelist of trusted domains. Initial whitelist:

**Data Sources:** `reuters.com`, `apnews.com`, `sec.gov`, `coindesk.com`, `coingecko.com`, `api.coingecko.com`, `finance.yahoo.com`

**LLM APIs:** `api.openai.com`, `api.anthropic.com`, `api.mistral.ai`, `generativelanguage.googleapis.com`

Whitelist governance is managed by the contract owner (Phase 1), with plans for decentralized staking-based governance in Phase 4.

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
