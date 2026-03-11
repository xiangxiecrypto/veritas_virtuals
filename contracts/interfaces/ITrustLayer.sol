// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Attestation} from "./IPrimusZKTLS.sol";

/**
 * @title ITrustLayer
 * @notice Public interface for the TrustLayer verification system.
 *
 * The verifier is responsible ONLY for cryptographic proof verification:
 *   - Primus attestation signature validity
 *   - Recipient matches provider wallet
 *   - Attestation freshness (timestamp)
 *   - Cross-step chain linkage (hash dependency)
 *   - Bundle chain hash integrity
 *
 * Business-level rules (domain whitelists, required steps, scoring, etc.)
 * belong in IEvaluatorPolicy contracts deployed by individual evaluators.
 */
interface ITrustLayer {

    // ── Structs ─────────────────────────────────────────────

    struct ProofStep {
        string stepId;
        /// Primus SDK task identifier used for bundle-level integrity hashing.
        /// This is TrustLayer metadata, not part of the Primus Attestation struct.
        string primusTaskId;
        Attestation attestation;
    }

    struct ProofBundle {
        ProofStep[] steps;
        bytes32 chainHash;
        address providerWallet;
        uint256 builtAt;
    }

    // ── Events ───────────────────────────────────────────────

    event TrustLayerVerified(
        address indexed provider,
        bytes32 indexed chainHash,
        uint256 stepCount,
        uint256 verifiedAt
    );

    event TrustLayerFailed(
        address indexed provider,
        string reason
    );

    // ── Core Verification ────────────────────────────────────

    function verifyProofBundle(
        ProofBundle calldata bundle,
        address providerAddress
    ) external view returns (bool verified);

    // ── Configuration ────────────────────────────────────────

    function maxAttestationAge() external view returns (uint256);
}
