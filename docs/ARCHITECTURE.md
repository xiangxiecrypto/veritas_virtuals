# TrustLayer — Architecture Deep Dive

## The Core Problem

Virtuals ACP's `Deliverable Memo` is just a signed JSON payload. Nothing in the
protocol prevents a Provider from fabricating results. The escrow release is
gated on a human or Agent signature — both of which can be deceived.

TrustLayer answers one question: **how do you prove that the content of a
Deliverable Memo genuinely originated from the data sources and LLMs the
Provider claims to have used?**

---

## Trust Model

### What TrustLayer Does NOT Trust
- The Provider process itself
- The Provider's claims about what APIs they called
- Any off-chain log or trace the Provider submits
- The Buyer's ability to independently verify results

### What TrustLayer DOES Trust
- **Primus Attestor nodes** — TEE-hardened, hardware-isolated, cannot collude
- **TLS certificates** — the standard PKI that secures the entire internet
- **SHA-256** — cryptographic hash function
- **The Base blockchain** — immutable record of all verifications

---

## Proof Chain Mechanics

### Single Step
A single step proves one HTTPS request-response pair:

```
┌───────────────────────────────────────────────────┐
│  Primus Attestor (Phala TEE)                      │
│                                                   │
│  Client → [MPC/Proxy TLS] → reuters.com           │
│                           ← { article_content }   │
│                                                   │
│  Attestation {                                    │
│    recipient: providerWallet,                     │
│    request: { url, headers, body },               │
│    data: '{"article_content":"..."}',             │  ← verified response
│    timestamp: 1741689824000,                      │
│    signature: attestorECDSA                       │
│  }                                                │
└───────────────────────────────────────────────────┘
```

The Attestor's signature proves: the response **actually came from reuters.com
over a properly negotiated TLS session** at the given timestamp. The Provider
cannot forge this without compromising the Primus TEE.

### Chain Linkage

The key insight is that Step B's request body must contain
`SHA256(Step A's response data)`:

```
Step A (data source):
  data = '{"article_content":"Tesla CEO said..."}'
  dataHash = SHA256(data) = "abc123..."

Step B (LLM inference):
  request.body = '{
    "messages": [{
      "content": "[source_hash:data_source:abc123...]  ← MUST be here
                  Tesla CEO said...
                  Fact check this claim..."
    }]
  }'
```

On-chain verification confirms:
1. `SHA256(Step A data) == "abc123..."` ← from Attestation A
2. `"abc123..." ∈ Step B request body` ← from Attestation B
3. Both Attestations signed by Primus TEE ← from `verifyAttestation()`

**The chain is broken if the Provider uses different data in the LLM prompt
than what they actually fetched** — the hashes won't match.

---

## Attack Vectors and Defenses

### Attack 1: Fabricate the data source response
Provider invents a Reuters article that supports their conclusion.

**Defense**: Primus Attestor witnesses the actual TLS session with reuters.com.
The response in the Attestation is exactly what Reuters returned. If the
Provider didn't hit the real Reuters endpoint, the TLS handshake won't
produce a valid Attestation.

### Attack 2: Tamper with data before sending to LLM
Provider fetches real Reuters data, then modifies it before including it
in the LLM prompt.

**Defense**: Chain linkage. `SHA256(verified_reuters_data)` must appear in
the LLM prompt body. Any modification to the data changes its SHA256, breaking
the link. The on-chain verifier will reject it.

### Attack 3: Use a local fake LLM
Provider runs a local model that always returns favorable verdicts.

**Defense**: Step B's Attestation proves the HTTPS request went to
`api.openai.com`. The domain whitelist on-chain rejects any other endpoint.
The Provider cannot get a valid Attestation for `api.localfake.com`.

### Attack 4: Replay an old proof bundle
Provider reuses a valid proof bundle from a previous job.

**Defense**: Timestamps. Each Attestation embeds the millisecond timestamp
when it was generated. The on-chain verifier rejects attestations older than
`maxAttestationAge` (default 10 minutes). A proof bundle must be freshly
generated for each job.

### Attack 5: Swap the recipient address
Provider generates a proof bundle with `recipient = 0xEVIL` and submits it
for their own job.

**Defense**: The on-chain verifier checks `attestation.recipient == providerAddress`.
The recipient is set during attestation generation by the Primus SDK — the
Provider cannot change it after signing.

### Attack 6: Collusion with Primus Attestor
Provider bribes or hacks a Primus Attestor to sign fake attestations.

**Defense**: Primus Attestors run inside Phala Network TEEs (Trusted Execution
Environments). The attestor code is remotely attested — Phala hardware
guarantees the correct code is running. Even Primus employees cannot inject
fraudulent attestations. This is the hardware-level trust anchor of the system.

### Residual Attack: Manipulate the LLM prompt framing
Provider fetches real data, embeds its hash, but writes a misleading system
prompt that biases the LLM toward their desired conclusion.

**Defense**: ❌ **Not fully mitigated.** TrustLayer proves the *data* was
real and *some* LLM produced the output. It cannot prove the *reasoning* was
sound. This is the acknowledged residual risk — equivalent to a human analyst
cherry-picking how to frame their analysis.

Partial mitigation: expose the full `system prompt` and `user message` in the
Attestation's `request.body` field. Buyers can inspect the prompting approach
and decide whether they trust the Provider's methodology.

---

## On-chain Verification Flow

```
Buyer calls: TrustLayerVerifier.verifyProofBundle(bundle, providerAddress)

For each step i in bundle.steps:
  1. primus.verifyAttestation(att)         → TEE signature valid
  2. att.recipient == providerAddress      → correct provider
  3. extractDomain(att.request[0].url)     → in whitelist
  4. att.timestamp > now - maxAge          → not stale
  5. if i > 0:
       SHA256(steps[i-1].data) ∈ steps[i].request.body  → chain intact

After loop:
  6. rollingKeccak(all taskIds) == bundle.chainHash      → bundle unmodified

Returns: true (or reverts with specific reason)
```

---

## Primus SDK Mode Selection

| Mode | How It Works | When to Use |
|---|---|---|
| `proxytls` | Attestor acts as TLS proxy, records ciphertext, client proves plaintext | Public data sources, no sensitive credentials in request |
| `mpctls` | Attestor and client co-generate TLS session keys via MPC | Authenticated APIs (OpenAI, Anthropic) where API key in headers must be protected |

For Fact Check: use `proxytls` for Reuters/news sources, `mpctls` for LLM APIs.
The API key in the `Authorization: Bearer sk-...` header is never revealed to
the Attestor in MPC mode.

---

## Gas Cost Estimates (Base L2)

| Operation | Estimated Gas | Cost @ 0.01 gwei |
|---|---|---|
| `verifyAttestation` (1 step) | ~80,000 | ~$0.001 |
| `verifyProofBundle` (2 steps) | ~200,000 | ~$0.002 |
| `verifyProofBundle` (5 steps) | ~450,000 | ~$0.005 |
| Full job with bundle submission | ~300,000 | ~$0.003 |

On Base L2, the full verification costs less than $0.01 per job — negligible
relative to the 0.20 USDC protocol fee.
