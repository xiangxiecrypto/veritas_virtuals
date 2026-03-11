# TrustLayer — Architecture Deep Dive

## The Core Problem

Virtuals ACP's `Deliverable Memo` is just a signed JSON payload. It proves that
a Provider submitted *something*, but it does not prove that the Provider
actually called the HTTPS APIs they claim to have used, nor that later results
were derived from earlier verified data.

TrustLayer answers this question:

**How do you prove that a deliverable genuinely came from a specific sequence of
HTTPS API calls?**

This applies to many workflows:

- fetch market data, then call a risk engine
- fetch a private dataset, then call an LLM
- fetch a custody balance, then call a portfolio analyzer
- fetch news, then call a fact-checking or summarization model

The system is intentionally **general-purpose**. Fact check is only one example.

---

## Trust Model

### What TrustLayer Does NOT Trust

- The Provider process itself
- The Provider's claims about which APIs were called
- Any off-chain logs or traces submitted by the Provider
- A Buyer's ability to manually inspect every intermediate result

### What TrustLayer DOES Trust

- **Primus core-sdk attestation format and verifier logic**
- **TLS certificates** and the standard HTTPS trust model
- **SHA-256** for chain linkage between steps
- **Base** when optional on-chain verification is required

---

## Proof Chain Mechanics

### Single Step

A single TrustLayer step proves one HTTPS request-response pair.
In the enterprise/core-sdk model, the proof is generated **off-chain** by the
Provider runtime:

```
┌────────────────────────────────────────────────────────┐
│ Provider runtime                                       │
│   └─ @primuslabs/zktls-core-sdk                        │
│        ├─ init(appId, appSecret)                       │
│        ├─ generateRequestParams(...)                   │
│        ├─ setAttMode(...)                              │
│        ├─ startAttestation(...)                        │
│        └─ verifyAttestation(...)                       │
│                                                        │
│ Output: Attestation { request, data, timestamp, ... }  │
└────────────────────────────────────────────────────────┘
```

This attestation proves that the response was produced by the attested HTTPS
endpoint at that time, under a valid TLS session, and that the returned data
was not fabricated locally by the Provider.

### Chain Linkage

TrustLayer becomes powerful when multiple steps are linked together.

Step `B` must include `SHA256(stepA.data[sourceField])` inside its request body.
That creates a cryptographic dependency between the two steps.

```
Step A:
  url = "https://api.example.com/source"
  data = '{"source_value":"abc"}'
  dataHash = SHA256(data) = "abc123..."

Step B:
  url = "https://api.example.com/transform"
  request.body contains "[source_hash:step_a:abc123...]"
```

On-chain verification, if used, checks:

1. `SHA256(stepA.attestation.data)` is the expected hash anchor
2. that hash appears inside `stepB.attestation.request.body`
3. both attestations are valid Primus proofs

If the Provider swaps the input, edits the intermediate payload, or calls the
downstream API with different data, the hash link breaks and verification fails.

---

## Why This Is General

TrustLayer does **not** assume that the second step is an LLM.

Step `B` may be:

- another data API
- an internal risk/scoring service
- an LLM endpoint
- a compliance engine
- an analytics or simulation API

The only requirement is that the call is made over HTTPS. Domain restrictions,
if any, are defined by each evaluator in their `IEvaluatorPolicy` contract.

---

## Attack Vectors and Defenses

### Attack 1: Fabricate a source response

The Provider invents a response and claims it came from a real API.

**Defense**: The off-chain attestation binds the request, response, and
timestamp. Local fabrication will fail SDK verification and optional on-chain
verification.

### Attack 2: Tamper with intermediate data

The Provider fetches real data, then modifies it before sending it to the next
API.

**Defense**: Chain linkage. The downstream request body must contain the hash of
the upstream verified data. Any modification changes the hash and breaks the
proof chain.

### Attack 3: Call a fake downstream service

The Provider replaces a trusted downstream API with a local or malicious one.

**Defense**: The attestation proves which HTTPS domain was contacted. Each
evaluator's `IEvaluatorPolicy` contract can enforce a domain whitelist to
reject calls to untrusted endpoints.

### Attack 4: Replay an old proof bundle

The Provider reuses a previously valid bundle.

**Defense**: The verifier checks the attestation timestamp against
`maxAttestationAge`. Old proofs are rejected.

### Attack 5: Swap the recipient address

The Provider generates a proof for a different wallet and attempts to reuse it.

**Defense**: The attestation recipient must match the Provider wallet address
passed into the verifier.

### Attack 6: Skip external verification

The Provider generates an attestation but hopes nobody independently verifies
it.

**Defense**: TrustLayer supports two validation modes:

- off-chain verification with `verifyAttestation()` in the SDK
- optional on-chain verification via `TrustLayerVerifier`

ACP integrations that need escrow-level guarantees should use the on-chain path.

### Residual Risk: Correctness of reasoning

TrustLayer proves that:

- a request hit a real HTTPS endpoint
- a later request depended on earlier verified data
- the final output came from the attested downstream API

TrustLayer does **not** prove that:

- an LLM's reasoning is correct
- a model did not hallucinate
- a business decision built on verified data is logically sound

That residual risk exists for any model or downstream compute service. The proof
layer establishes provenance, not universal correctness.

---

## On-chain Verification Flow

```
Optional on-chain path:
  Buyer or ACP hook calls TrustLayerVerifier.verifyProofBundle(bundle, providerAddress)

For each step in bundle.steps:
  1. primus.verifyAttestation(att)         -> attestation signature valid
  2. att.recipient == providerAddress      -> correct provider
  3. att.timestamp within max age window   -> not stale
  4. if step index > 0:
       SHA256(prevStep.data) in current request body -> chain intact

After all steps:
  5. rollingKeccak(all step.primusTaskId values) == bundle.chainHash  -> bundle unmodified

Note: domain whitelisting is NOT part of the verifier. Domain checks belong
in each evaluator's IEvaluatorPolicy contract (see below).
```

`bundle.chainHash` is a rolling `keccak256` over all `step.primusTaskId`
values and must match the verifier's computation exactly. These ids come from
the Primus SDK result and are carried by TrustLayer at the step level; they are
not fields inside the official Primus on-chain `Attestation` struct.

## Evaluator Policy Architecture

TrustLayerACPHook delegates business-level verification to external
**IEvaluatorPolicy** contracts. Each evaluator deploys their own Solidity
contract that implements a single `check(bundle, provider)` function:

```
┌──────────────────────────┐
│   ACP Job Contract       │
│     ↓ onEvaluate         │
├──────────────────────────┤
│   TrustLayerACPHook      │
│     1. proof authenticity │ ← TrustLayerVerifier
│     2. policy.check()    │ ← IEvaluatorPolicy (evaluator's contract)
│     3. cache result      │
└──────────────────────────┘
```

### Why interface-based policies?

- **Full freedom**: Any Solidity logic — step requirements, domain checks,
  cross-step data validation, custom scoring, time-dependent rules.
- **Low deployment cost**: A minimal policy contract is ~200 lines. Deploy once
  and register via `hook.setPolicy(address)`.
- **Isolated upgrades**: Evaluator deploys a new contract and calls
  `setPolicy()` again. Other evaluators are unaffected.
- **Composability**: Policies can call other contracts, oracles, or libraries.

### Lifecycle

1. Evaluator writes a contract implementing `IEvaluatorPolicy`.
2. Evaluator deploys it (one transaction).
3. Evaluator calls `hook.setPolicy(contractAddress)` (one transaction).
4. From this point, all `verifyDeliverable()` calls for this evaluator
   are **fully automated** — the hook calls the policy contract and the
   result determines escrow release.

See `contracts/policies/FactCheckPolicy.sol` for a reference implementation.

---

## Primus SDK Integration

TrustLayer's SDK integration is built around
`@primuslabs/zktls-core-sdk` and follows the standard flow described in the
Primus docs:

1. `init(appId, appSecret)`
2. `generateRequestParams(request, responseResolves)`
3. `setAttMode({ algorithmType })`
4. `startAttestation(generateRequest)`
5. `verifyAttestation(attestation)`

Reference: [Primus core-sdk simple example](https://docs.primuslabs.xyz/enterprise/core-sdk/simpleexample)

This is an **enterprise/off-chain** integration pattern.
TrustLayer does not require the Primus decentralized zkTLS network to generate
proofs in this mode.

---

## Verification Modes

TrustLayer supports two verification layers:

### Off-chain Verification

This is the default enterprise/core-sdk path.

- the Provider runtime generates the attestation
- the SDK immediately validates it with `verifyAttestation()`
- a Buyer or backend service can repeat the same validation off-chain

### On-chain Verification

This is optional and is only needed when you want the blockchain itself to gate
state transitions such as escrow release.

- `IPrimusZKTLS.verifyAttestation(attestation)` validates the attestation
- `TrustLayerVerifier` adds bundle-level checks: recipient, timestamp
  freshness, and step linkage
- `IEvaluatorPolicy` contracts add business rules: domain whitelists,
  required steps, scoring, etc.

---

## Default TLS Mode

TrustLayer now defaults to **`proxytls`**.

Why:

- it is faster
- it is easier to use in production ACP flows
- it is more likely to fit realistic SLA constraints

Use `mpctls` only when you explicitly decide the extra privacy/security is worth
the latency cost.

Practical rule:

- `proxytls` for most HTTPS APIs, including most provider pipelines
- `mpctls` only for rare, highly sensitive authenticated calls

---

## Gas Cost Estimates (Base L2)

| Operation | Estimated Gas | Cost @ 0.01 gwei |
|---|---|---|
| `verifyAttestation` (1 step) | ~80,000 | ~$0.001 |
| `verifyProofBundle` (2 steps) | ~200,000 | ~$0.002 |
| `verifyProofBundle` (5 steps) | ~450,000 | ~$0.005 |
| `verifyDeliverable` (proof + policy) | ~300,000 | ~$0.003 |
| Deploy a minimal policy contract | ~200,000 | ~$0.002 |
| `setPolicy()` (one-time) | ~50,000 | ~$0.0005 |

On Base L2, full verification is cheap enough to gate escrow without materially
changing the economics of most ACP jobs. Deploying a new policy contract is a
one-time cost and is comparable to a single verification call.

---

## Contract Relationships

```
┌──────────────────────┐   ┌────────────────────┐
│  TrustLayerVerifier  │   │  IPrimusZKTLS      │
│  verifyProofBundle() │──►│  verifyAttestation()│
│  timestamp checks    │   └────────────────────┘
│  chain linkage       │
└──────────┬───────────┘
           │ called by
┌──────────▼───────────┐   ┌────────────────────┐
│  TrustLayerACPHook   │   │  IEvaluatorPolicy  │
│  verifyDeliverable() │──►│  check()           │
│  provider registry   │   │  (per-evaluator)   │
│  result cache        │   └────────────────────┘
└──────────────────────┘
           │ called by
┌──────────▼───────────┐
│  ACP Job Contract    │
│  onEvaluate()        │
│  escrow release      │
└──────────────────────┘
```
