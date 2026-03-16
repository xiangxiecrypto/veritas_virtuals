# Veritas — Architecture Deep Dive

## Overview

Veritas is a provenance and verification layer for agent commerce. It proves
that a provider actually called specific HTTPS endpoints, and that later steps
in a workflow were derived from earlier verified results.

The current on-chain integration target in this repository is ERC-8183.

## Design Goals

- Prove real HTTPS data origin
- Prove cross-step dependency between requests
- Keep proof verification separate from business logic
- Let evaluators define their own policies
- Integrate cleanly with escrow protocols through hooks

## Layered Model

```text
Layer 5: IEvaluatorPolicy contracts
  Workflow-specific business rules

Layer 4: On-chain integration
  VeritasVerifier
  VeritasERC8183Hook

Layer 3: Provider runtime
  ProofChainBuilder
  StepProver

Layer 2: Attestation engine
  @primuslabs/zktls-core-sdk

Layer 1: External HTTPS APIs
  CoinGecko, Reuters, LLM endpoints, internal APIs
```

## Proof Model

### Single Step

A single step is one HTTPS request/response pair attested by Primus zkTLS.

Each step captures:

- request URL, headers, method, and body
- attested response-derived `data`
- timestamp
- attestor metadata
- signature material

### Linked Steps

Later steps can depend on earlier steps by embedding a hash anchor into the
downstream request body.

```text
step A -> attestation.data
step B -> request.body contains SHA256(stepA.attestation.data)
```

This prevents silent tampering between steps.

### Bundle Integrity

Multiple steps are wrapped into a `ProofBundle`.

Bundle-level integrity is enforced with:

- ordered `steps`
- `providerWallet`
- `builtAt`
- `chainHash`

`chainHash` is computed from the ordered `primusTaskId` values and becomes the
canonical identity of the bundle in the ERC-8183 submission flow.

## Off-chain Components

### `ProofChainBuilder`

`ProofChainBuilder` is the main SDK entry point. It:

- initializes Primus core SDK
- adds attested steps
- enforces cross-step body linkage
- accumulates step results
- builds the final `ProofBundle`

### `StepProver`

`StepProver` handles one step at a time. It:

- optionally checks trusted domains off-chain
- builds request parameters for Primus
- runs the attestation
- verifies the attestation off-chain
- parses extracted data fields

## On-chain Components

### `VeritasVerifier`

`VeritasVerifier` only checks proof authenticity.

It verifies:

1. Primus attestation signatures
2. recipient matches provider wallet
3. attestation freshness
4. cross-step chain linkage
5. bundle `chainHash` integrity

It deliberately does **not** verify:

- trusted domains
- required step ids
- scoring thresholds
- workflow-specific semantics

### `IEvaluatorPolicy`

`IEvaluatorPolicy` is the business-rule extension point.

Each evaluator can deploy an arbitrary contract implementing:

```solidity
function check(
    IVeritas.ProofBundle calldata bundle,
    address provider
) external view returns (bool passed);
```

Typical checks:

- require `data_source` and `llm_inference`
- only allow trusted domains
- enforce stricter freshness windows
- validate extracted fields or step counts

### `VeritasERC8183Hook`

This hook integrates Veritas into ERC-8183 job submission and completion.

Expected submission convention:

- `deliverable == bundle.chainHash`
- `optParams == abi.encode(bundle)`

On `submit()` the hook:

1. decodes the bundle from `optParams`
2. checks `deliverable == bundle.chainHash`
3. reads the job from ERC-8183 core
4. validates provider alignment
5. calls `VeritasVerifier.verifyProofBundle(...)`
6. calls evaluator policy if configured
7. caches successful verification state

On `complete()` the hook:

- requires that the job has already passed Veritas verification

## ERC-8183 Boundary

ERC-8183 owns:

- job lifecycle
- escrow
- role separation between client/provider/evaluator
- `submit()` and `complete()` transitions

Veritas owns:

- proof generation
- proof encoding
- proof verification
- policy execution inside the hook

This separation keeps Veritas reusable across protocols.

## Domain Enforcement

There is no global verifier-level domain whitelist.

Reason:

- different evaluators trust different endpoints
- different workflows need different policies
- protocol flexibility is higher when business logic stays modular

SDK-side `trustedDomains` is optional and only for early local rejection.
Authoritative on-chain domain rules belong in `IEvaluatorPolicy`.

## Threat Model

### Veritas defends against

- fabricated source responses
- tampering between steps
- fake downstream API claims
- replay of stale proofs
- provider wallet substitution
- bundle replacement after generation

### Veritas does not prove

- that an LLM answer is correct
- that model reasoning is sound
- that a trading or compliance decision is optimal

Veritas proves provenance and execution integrity, not semantic correctness.

## Example Workflow

The token analysis example in this repository follows this pattern:

1. attested CoinGecko market data fetch
2. local computation of indicators
3. attested GLM-5 analysis request using source hash anchor
4. final report plus `proofBundle`
5. ERC-8183 submission through `VeritasERC8183Hook`

## Relevant Files

- `contracts/VeritasVerifier.sol`
- `contracts/VeritasERC8183Hook.sol`
- `contracts/interfaces/IVeritas.sol`
- `contracts/interfaces/IEvaluatorPolicy.sol`
- `src/core/ProofChainBuilder.ts`
- `src/core/StepProver.ts`
- `src/chain/OnChainSubmitter.ts`
