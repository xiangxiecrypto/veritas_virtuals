// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Attestation} from "./IPrimusZKTLS.sol";

/**
 * @title ITrustLayer
 * @notice Public interface for the TrustLayer verification system.
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

    event DomainWhitelisted(bytes32 indexed domainHash, string domain);
    event DomainRemoved(bytes32 indexed domainHash);

    // ── Core Verification ────────────────────────────────────

    function verifyProofBundle(
        ProofBundle calldata bundle,
        address providerAddress
    ) external view returns (bool verified);

    // ── Domain Whitelist ─────────────────────────────────────

    function isDomainTrusted(string calldata domain) external view returns (bool);
    function addTrustedDomain(string calldata domain) external;
    function removeTrustedDomain(string calldata domain) external;

    // ── Configuration ────────────────────────────────────────

    function maxAttestationAge() external view returns (uint256);
}
