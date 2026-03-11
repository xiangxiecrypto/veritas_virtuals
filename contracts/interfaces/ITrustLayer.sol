// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IPrimusZKTLS } from "./IPrimusZKTLS.sol";

/**
 * @title ITrustLayer
 * @notice Public interface for the TrustLayer verification system.
 */
interface ITrustLayer {

    // ── Structs ─────────────────────────────────────────────

    struct ProofStep {
        string stepId;
        IPrimusZKTLS.Attestation attestation;
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

    /**
     * @notice Verify a complete ProofBundle on-chain.
     *
     * Checks:
     *  1. Each attestation passes Primus signature verification
     *  2. Each attestation's recipient == providerAddress
     *  3. Each URL domain is in the trusted whitelist
     *  4. Each attestation timestamp is within the allowed age window
     *  5. Chain linkage: step[i].body contains SHA256(step[i-1].data)
     *  6. chainHash matches the computed rolling hash of all taskIds
     *
     * @param bundle    The ProofBundle from the ACP Deliverable Memo
     * @param providerAddress  The Provider's registered wallet address
     * @return verified  True if all checks pass. Reverts with reason if not.
     */
    function verifyProofBundle(
        ProofBundle calldata bundle,
        address providerAddress
    ) external view returns (bool verified);

    // ── Domain Whitelist ─────────────────────────────────────

    /**
     * @notice Check if a domain is in the trusted whitelist.
     * @param domain  Plain domain string, e.g. "api.openai.com"
     */
    function isDomainTrusted(string calldata domain) external view returns (bool);

    /**
     * @notice Add a domain to the whitelist. Owner only.
     */
    function addTrustedDomain(string calldata domain) external;

    /**
     * @notice Remove a domain from the whitelist. Owner only.
     */
    function removeTrustedDomain(string calldata domain) external;

    // ── Configuration ────────────────────────────────────────

    /**
     * @notice Maximum age of a valid attestation in seconds.
     *         Attestations older than this are rejected.
     */
    function maxAttestationAge() external view returns (uint256);
}
