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

The only requirement is that the call is made over HTTPS to a domain accepted
by the TrustLayer policy.

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

**Defense**: The attestation proves which HTTPS domain was contacted, and the
TrustLayer verifier can enforce a trusted domain whitelist when on-chain checks
are used.

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
  3. extractDomain(att.request.url)        -> domain allowed
  4. att.timestamp within max age window   -> not stale
  5. if step index > 0:
       SHA256(prevStep.data) in current request body -> chain intact

After all steps:
  6. rollingKeccak(all step.primusTaskId values) == bundle.chainHash  -> bundle unmodified
```

`bundle.chainHash` is a rolling `keccak256` over all `step.primusTaskId`
values and must match the verifier's computation exactly. These ids come from
the Primus SDK result and are carried by TrustLayer at the step level; they are
not fields inside the official Primus on-chain `Attestation` struct.

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
- `TrustLayerVerifier` adds bundle-level checks like domain policy, recipient,
  timestamp freshness, and step linkage

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
| Full job with bundle submission | ~300,000 | ~$0.003 |

On Base L2, full verification is cheap enough to gate escrow without materially
changing the economics of most ACP jobs.
