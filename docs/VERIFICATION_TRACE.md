# Verification Trace

> Historical verification trace for the earlier ACP integration. The repository now targets ERC-8183 hooks by default; this document is retained only as a decoded reference for that older demo path.

This document records one complete Base Sepolia verification run that successfully
executed the full path:

`provider registration -> verifier -> ACP integration hook -> FactCheckPolicy`

All sensitive values are redacted. Transaction hashes, contract addresses, decoded
payloads, and verification outcomes are preserved for demonstration purposes.

## Network And Contracts

| Component | Address |
|---|---|
| VeritasVerifier | `0x5D39Ef731fDfd3d49D033724d70be0FD0E31172c` |
| VeritasACPHook | `0x1306063A2b701Bc3D5912E36A9dbe414cCbDf385` |
| FactCheckPolicy | `0xDbbD7239947Bfe3320e98B937CDBF7553Bceb0Bd` |
| Primus zkTLS Verifier | `0xCE7cefB3B5A7eB44B59F60327A53c9Ce53B0afdE` |
| Provider wallet | `0x89BBf3451643eef216c3A60d5B561c58F0D8adb9` |

## Transactions

| Purpose | Hash |
|---|---|
| Register provider on hook | `0x221e6636da1018ebbf4876f6ae19ab8258fd5747550e5805aec20a09b8aa6b4e` |
| Full on-chain verification via `verifyDeliverable` | `0x1d5d9e70ec5b9a54af1b908f0988af5b339ac28cbc7d4a6f16223eb408f4f472` |

## Pre-Verification State

- `veritasEnabled(provider) = false`
- `evaluatorPolicies(provider) = 0xDbbD7239947Bfe3320e98B937CDBF7553Bceb0Bd`
- `FactCheckPolicy.maxAgeSecs() = 600`
- `FactCheckPolicy.trustedDomains(keccak256("api.coinbase.com")) = true`
- `FactCheckPolicy.trustedDomains(keccak256("api.z.ai")) = true`

After `registerProvider()`:

- `veritasEnabled(provider) = true`

## Step 1: Coinbase Price Attestation

### Actual off-chain request

- URL: `https://api.coinbase.com/v2/prices/ETH-USD/spot`
- Method: `GET`
- Body: empty
- Response fields revealed:
  - `$.data.amount`
  - `$.data.base`
  - `$.data.currency`

### Revealed result

- `amount = 2071.165`
- `base = ETH`
- `currency = USD`

### Decoded attestation

```json
{
  "stepId": "data_source",
  "primusTaskId": "0e5661d438e06965f28bcd0160160c4b2023f0c093adef2ea3ef3051ac189dfe",
  "recipient": "0x89BBf3451643eef216c3A60d5B561c58F0D8adb9",
  "request": {
    "url": "https://api.coinbase.com/v2/prices/ETH-USD/spot",
    "header": "",
    "method": "GET",
    "body": ""
  },
  "responseResolve": [
    {
      "keyName": "amount",
      "parseType": "",
      "parsePath": "$.data.amount"
    },
    {
      "keyName": "base",
      "parseType": "",
      "parsePath": "$.data.base"
    },
    {
      "keyName": "currency",
      "parseType": "",
      "parsePath": "$.data.currency"
    }
  ],
  "data": "{\"amount\":\"\\\"2071.165\\\"\",\"currency\":\"\\\"USD\\\"\",\"base\":\"\\\"ETH\\\"\"}",
  "attConditions": "[{\"op\":\"REVEAL_STRING\",\"field\":\"$.data.amount\"},{\"op\":\"REVEAL_STRING\",\"field\":\"$.data.base\"},{\"op\":\"REVEAL_STRING\",\"field\":\"$.data.currency\"}]",
  "timestamp": "1773239902576",
  "additionParams": "{\"algorithmType\":\"proxytls\"}",
  "attestors": [
    {
      "attestorAddr": "0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6",
      "url": "https://primuslabs.xyz"
    }
  ],
  "signature": "0xd52ba4e73472cd12af0909c390e8dd911e92a3b04f7078cd75aa048178f808746f11cbd85400cc4d2b42e5d64fe94b745dafd8fd94bac835f8474f1cc03086171c"
}
```

## Step 2: GLM-5 Inference Attestation

### Actual off-chain request

- URL: `https://api.z.ai/api/paas/v4/chat/completions`
- Method: `POST`
- Headers:
  - `Authorization: Bearer <redacted>`
  - `Content-Type: application/json`

### Request body

```json
{
  "model": "glm-5",
  "response_format": {
    "type": "json_object"
  },
  "messages": [
    {
      "role": "system",
      "content": "Return JSON only: {\"verdict\":\"string\",\"summary\":\"string\"}"
    },
    {
      "role": "user",
      "content": "[source_hash:data_source:a7378daf33f5c0a24d1bd9989c5f6e15d31366be959fa0b6dd721a5ec0c47fd6]\nObserved price: 2071.165 USD\nAsset: ETH\nSummarize this market snapshot in one sentence."
    }
  ]
}
```

### Revealed result

- `model_used = glm-5`
- `response_text = {"verdict":"Neutral","summary":"Ethereum (ETH) is currently trading at an observed price of 2071.165 USD."}`

### Decoded attestation

```json
{
  "stepId": "llm_inference",
  "primusTaskId": "efee31bf476b903b66013d8ccc7b590bc535c4e0b3eb564f6b190dd30261504b",
  "recipient": "0x89BBf3451643eef216c3A60d5B561c58F0D8adb9",
  "request": {
    "url": "https://api.z.ai/api/paas/v4/chat/completions",
    "header": "",
    "method": "POST",
    "body": "{\"model\":\"glm-5\",\"response_format\":{\"type\":\"json_object\"},\"messages\":[{\"role\":\"system\",\"content\":\"Return JSON only: {\\\"verdict\\\":\\\"string\\\",\\\"summary\\\":\\\"string\\\"}\"},{\"role\":\"user\",\"content\":\"[source_hash:data_source:a7378daf33f5c0a24d1bd9989c5f6e15d31366be959fa0b6dd721a5ec0c47fd6]\\nObserved price: 2071.165 USD\\nAsset: ETH\\nSummarize this market snapshot in one sentence.\"}]}"
  },
  "responseResolve": [
    {
      "keyName": "response_text",
      "parseType": "",
      "parsePath": "$.choices[0].message.content"
    },
    {
      "keyName": "model_used",
      "parseType": "",
      "parsePath": "$.model"
    }
  ],
  "data": "{\"model_used\":\"\\\"glm-5\\\"\",\"response_text\":\"\\\"{\\\\\\\"verdict\\\\\\\":\\\\\\\"Neutral\\\\\\\",\\\\\\\"summary\\\\\\\":\\\\\\\"Ethereum (ETH) is currently trading at an observed price of 2071.165 USD.\\\\\\\"}\\\"\"}",
  "attConditions": "[{\"op\":\"REVEAL_STRING\",\"field\":\"$.choices[0].message.content\"},{\"op\":\"REVEAL_STRING\",\"field\":\"$.model\"}]",
  "timestamp": "1773239926084",
  "additionParams": "{\"algorithmType\":\"proxytls\"}",
  "attestors": [
    {
      "attestorAddr": "0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6",
      "url": "https://primuslabs.xyz"
    }
  ],
  "signature": "0xc1b684318c720a37d9943312646b67cb6fa569d116a44e14d802dd51bcb4579c4f7d208e888526d642c8d386cd2e91e15cfbae7d4309ce629d123360da0310291c"
}
```

## Bundle Submitted On-Chain

The successful verification transaction called:

- Contract: `VeritasACPHook`
- Address: `0x1306063A2b701Bc3D5912E36A9dbe414cCbDf385`
- Function: `verifyDeliverable(uint256 jobId, address providerAddress, address evaluatorAddress, bytes encodedBundle)`
- Transaction hash: `0x1d5d9e70ec5b9a54af1b908f0988af5b339ac28cbc7d4a6f16223eb408f4f472`

### Top-level decoded parameters

```json
{
  "jobId": 0,
  "providerAddress": "0x89BBf3451643eef216c3A60d5B561c58F0D8adb9",
  "evaluatorAddress": "0x89BBf3451643eef216c3A60d5B561c58F0D8adb9",
  "providerWallet": "0x89BBf3451643eef216c3A60d5B561c58F0D8adb9",
  "chainHash": "0xa453e35bccb3e65a8db12e766d45146e84993f16c7e1e072ef850bac0cfd95ea",
  "builtAt": "1773239927317",
  "stepCount": 2
}
```

### Bundle structure

- Step 1: `data_source`
- Step 2: `llm_inference`
- `chainHash = 0xa453e35bccb3e65a8db12e766d45146e84993f16c7e1e072ef850bac0cfd95ea`

## What Was Verified

### `VeritasVerifier`

The on-chain verifier checked:

- bundle is non-empty
- `bundle.providerWallet == providerAddress`
- each step attestation passes `Primus.verifyAttestation(attestation)`
- each step `attestation.recipient == providerAddress`
- each step `request.url` is non-empty
- each step attestation age is within `maxAttestationAge`
- step 2 request body contains the hash of step 1 attested data
- rolling `keccak256` over all `primusTaskId` values matches `bundle.chainHash`

### `FactCheckPolicy`

The evaluator policy checked:

- at least 2 steps exist
- a `data_source` step exists
- a `llm_inference` step exists
- every step domain is trusted
- every step attestation age is within `maxAgeSecs = 600`

For this run, the domains checked were:

- `api.coinbase.com`
- `api.z.ai`

## On-Chain Outcome

- transaction status: success
- gas used: `419391`
- emitted event: `DeliverableVerified`
- final cache state:
  - `veritasEnabled(provider) = true`
  - `evaluatorPolicies(provider) = 0xDbbD7239947Bfe3320e98B937CDBF7553Bceb0Bd`
  - `isProviderVerified(provider, chainHash) = true`

### Emitted event

```json
{
  "event": "DeliverableVerified",
  "provider": "0x89BBf3451643eef216c3A60d5B561c58F0D8adb9",
  "evaluator": "0x89BBf3451643eef216c3A60d5B561c58F0D8adb9",
  "chainHash": "0xa453e35bccb3e65a8db12e766d45146e84993f16c7e1e072ef850bac0cfd95ea",
  "jobId": "0"
}
```

## Notes

- In this recorded demo run, the same EOA was used as both `providerAddress` and
  the `evaluatorAddress` lookup key on `VeritasACPHook`.
- The policy contract actually enforcing business rules was
  `0xDbbD7239947Bfe3320e98B937CDBF7553Bceb0Bd`.
- In production, it is usually cleaner to let `evaluatorAddress` be an evaluator
  contract address, and bind that address to a policy contract via `setPolicy()`.
- The decoded attestation struct stores `request.header` as an empty string in this
  run. The actual off-chain GLM request did include an authorization header, but
  that sensitive header is intentionally redacted from this document.
