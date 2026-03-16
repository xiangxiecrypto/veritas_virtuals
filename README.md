# Veritas

> A verifiable execution and data provenance layer for ERC-8183 agent commerce

Veritas is a cryptographic verification layer that lets providers in ERC-8183 commerce **prove** that a sequence of **HTTPS API calls** actually happened as claimed, and that later outputs were derived from earlier verified responses.

1. They actually fetched data from a specific real-world HTTPS endpoint (e.g. Reuters, SEC, CoinGecko)
2. They fed that **exact, unmodified** data into a subsequent HTTPS call (often an LLM API, but not limited to OpenAI)
3. The final output attached to the job is **genuinely what the attested API returned** — not fabricated

Every step is attested **off-chain** using [Primus zkTLS](https://primuslabs.xyz) via `@primuslabs/zktls-core-sdk`. The resulting attestation can be verified off-chain in the SDK, and can also be verified on-chain inside an ERC-8183 hook before escrow completion.

---

## The Problem

In agent commerce, a provider can submit a deliverable hash without proving how the result was produced. A fact-check agent could return `{"verdict":"True","score":95}` without ever calling a real data source or LLM. Escrow could still release if the evaluator accepts.

Veritas fixes this at the **cryptographic layer**, not at the reputation layer.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Layer 5: Evaluator Policy Contracts (IEvaluatorPolicy)      │
│  Each evaluator deploys custom Solidity logic.               │
│  VeritasERC8183Hook calls policy.check() automatically.     │
└───────────────────────────┬──────────────────────────────────┘
                            │ fully automated evaluation
┌───────────────────────────▼──────────────────────────────────┐
│  Layer 4: On-chain Verification (Base Chain)                 │
│  VeritasVerifier.sol ──► IPrimusZKTLS.verifyAttestation     │
│  VeritasERC8183Hook.sol ──► submit hook + policy.check()    │
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
│  reuters.com / sec.gov / api.openai.com / api.z.ai / api.anthropic.com │
└──────────────────────────────────────────────────────────────┘
```

### What Veritas Proves vs Cannot Prove

| Threat | Veritas Defence |
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
veritas/
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
│   ├── VeritasVerifier.sol        # Core on-chain verifier
│   ├── VeritasERC8183Hook.sol     # ERC-8183 hook integration
│   ├── interfaces/
│   │   ├── IPrimusZKTLS.sol         # Primus attestation interface
│   │   ├── IVeritas.sol           # Veritas public interface
│   │   ├── IEvaluatorPolicy.sol     # Evaluator policy interface
│   │   ├── IACPHook.sol             # ERC-8183 hook interface name used upstream
│   │   └── IAgenticCommerce.sol     # Minimal ERC-8183 core interface
│   ├── policies/
│   │   └── FactCheckPolicy.sol      # Reference evaluator policy
│   │   └── TokenAnalysisPolicy.sol  # Token analysis evaluator policy
│   └── libraries/
│       └── ProofParser.sol          # ABI decode helpers
├── examples/
│   ├── fact-check/
│   │   ├── provider.ts              # Fact-check deliverable builder
│   │   └── evaluator.ts             # ERC-8183 evaluation helpers
│   └── generic-api-pipeline/
│       ├── provider.ts              # Generic HTTPS source -> scoring pipeline
│       └── evaluator.ts             # Generic ERC-8183 verification helpers
│   └── token-analysis/
│       ├── provider.ts              # CoinGecko -> GLM-5 token analysis provider
│       ├── buyer.ts                 # Consumer-side review/status helpers
│       ├── evaluator.ts             # ERC-8183 submission helpers
│       ├── indicators.ts            # Local RSI/MACD/Bollinger/MA calculations
│       └── coingecko.ts             # CoinGecko asset + series helpers
├── docs/
│   ├── ARCHITECTURE.md              # Deep-dive architecture doc
│   └── INTEGRATION_GUIDE.md         # Provider & evaluator integration guide
├── package.json
├── tsconfig.json
└── .env.example
```

## Documentation

- `docs/ARCHITECTURE.md`: current Veritas + ERC-8183 architecture deep dive
- `docs/INTEGRATION_GUIDE.md`: current end-to-end integration guide
- `docs/VERIFICATION_TRACE.md`: historical decoded verification trace from the earlier ACP-era demo

---

## Quick Start

### 1. Install

```bash
npm install @veritas/sdk
```

### 2. Provider: Generate a Proof Chain

```typescript
import { ProofChainBuilder } from "@veritas/sdk";

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
  url: "https://api.z.ai/api/paas/v4/chat/completions",
  method: "POST",
  headers: { "Authorization": `Bearer ${process.env.ZAI_API_KEY}` },
  bodyBuilder: (prevSteps) => {
    const content = prevSteps["data_source"].data["article_content"];
    return JSON.stringify({
      model: "glm-5",
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

// Attach to your off-chain report or job metadata
const deliverable = JSON.stringify({
  verdict: "Partially True",
  score: 62,
  proofBundle,   // <-- Veritas proof chain
});
```

### 3. Evaluator: Deploy a Policy Contract (one-time)

Each evaluator deploys their own `IEvaluatorPolicy` contract with arbitrary
Solidity verification logic, then registers it on the hook:

```solidity
// Example: FactCheckPolicy — requires data_source + llm_inference steps
contract FactCheckPolicy is IEvaluatorPolicy {
    function check(
        IVeritas.ProofBundle calldata bundle,
        address provider
    ) external view returns (bool) {
        require(bundle.steps.length >= 2, "need 2 steps");
        // ... any custom business logic ...
        return true;
    }
}
```

```typescript
import { OnChainSubmitter } from "@veritas/sdk";

const submitter = new OnChainSubmitter(privateKey, "base_sepolia", undefined, {
  VeritasERC8183Hook: hookAddress,
});

// One-time: point evaluator to the deployed policy contract
await submitter.setPolicy(factCheckPolicyAddress);
```

After `setPolicy()`, all ERC-8183 `submit()` calls routed through the hook are
fully automated — the hook checks proof authenticity and calls `policy.check()`.

### Token Analysis Example

The repository also includes a `token_analysis` example service:

- `examples/token-analysis/provider.ts`: attests CoinGecko market data, computes RSI/MACD/Bollinger Bands/moving averages/volume signals locally, then attests a GLM-5 analysis step.
- `examples/token-analysis/buyer.ts`: consumer-side helpers for reviewing token analysis deliverables and checking on-chain verification status.
- `contracts/policies/TokenAnalysisPolicy.sol`: verifies `data_source` + `llm_inference`, CoinGecko / GLM domains, and attestation freshness on-chain.

### 4. On-chain Verification Flow

```
submit(jobId, bundle.chainHash, encodedBundle)
  ├─ ERC-8183 core calls VeritasERC8183Hook.beforeAction(...)
  ├─ VeritasVerifier.verifyProofBundle(bundle, provider)   // proof authenticity
  ├─ IEvaluatorPolicy(evaluator).check(bundle, provider)      // business logic
  └─ cache result → evaluator can safely complete escrow
```

You can also verify attestations off-chain with the Primus core-sdk before ever
calling a contract. Veritas uses that off-chain verification path during
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
| VeritasVerifier (Base Sepolia) | `0x5D39Ef731fDfd3d49D033724d70be0FD0E31172c` |
| VeritasERC8183Hook (Base Sepolia) | `deploy your own against your ERC-8183 core` |
| FactCheckPolicy (Base Sepolia) | `0xDbbD7239947Bfe3320e98B937CDBF7553Bceb0Bd` |
| Primus zkTLS Verifier (Base mainnet & Sepolia) | `0xCE7cefB3B5A7eB44B59F60327A53c9Ce53B0afdE` |

See `docs/VERIFICATION_TRACE.md` for a full decoded verification trace covering
off-chain API requests, attestation payloads, on-chain bundle submission, and the
final `Hook + Verifier + Policy` result. That document currently reflects an older
ACP-era demo and is kept as historical reference only.

---

## Domain Policy

Veritas supports **any HTTPS API**. There is no global domain whitelist at the
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

Veritas defaults to `proxytls`.

Use `mpctls` only when you explicitly set `mode: "mpctls"` for a step and are
comfortable with the additional latency.

---

## Integration Phases

| Phase | Description |
|---|---|
| **Phase 1** (Now) | Veritas SDK + contracts deployed independently alongside an ERC-8183 `AgenticCommerce` deployment |
| **Phase 2** | Evaluators deploy `IEvaluatorPolicy` contracts and call `setPolicy()`. Verification runs automatically during ERC-8183 `submit()` |
| **Phase 3** | Ecosystem adoption: more evaluator policies, more providers, community-contributed policy templates |

---

## License

MIT
