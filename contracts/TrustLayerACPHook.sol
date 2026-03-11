// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ITrustLayer } from "./interfaces/ITrustLayer.sol";

/**
 * @title TrustLayerACPHook
 * @notice Integration hook between TrustLayer and the Virtuals ACP Job system.
 *
 * Providers that opt into TrustLayer register here. When their ACP Job
 * reaches the EVALUATION phase, this contract is called to verify the
 * ProofBundle before the escrow can release.
 *
 * ACP Job contracts call `verifyDeliverable()` in their onEvaluate hook.
 *
 * ┌─────────────────────────────────────────┐
 * │  ACP Job Contract                       │
 * │  onEvaluate:                            │
 * │    if trustLayerEnabled[provider]:      │
 * │      ACPHook.verifyDeliverable(...)  ✅  │
 * │    escrow.release()                     │
 * └─────────────────────────────────────────┘
 */
contract TrustLayerACPHook is Ownable {

    // ── State ────────────────────────────────────────────────

    ITrustLayer public verifier;

    /// Providers who have opted into TrustLayer verification
    mapping(address => bool) public trustLayerEnabled;

    /// provider → chainHash → verified
    mapping(address => mapping(bytes32 => bool)) public verifiedBundles;

    // ── Events ───────────────────────────────────────────────

    event ProviderRegistered(address indexed provider);
    event ProviderDeregistered(address indexed provider);
    event DeliverableVerified(
        address indexed provider,
        bytes32 indexed chainHash,
        uint256 jobId
    );

    // ── Constructor ──────────────────────────────────────────

    constructor(address verifierAddress) Ownable(msg.sender) {
        verifier = ITrustLayer(verifierAddress);
    }

    // ── Provider Registration ────────────────────────────────

    /**
     * @notice Provider opts into TrustLayer verification.
     *         Once enabled, all their ACP jobs will require proof bundles.
     */
    function registerProvider() external {
        trustLayerEnabled[msg.sender] = true;
        emit ProviderRegistered(msg.sender);
    }

    /**
     * @notice Provider opts out of TrustLayer verification.
     */
    function deregisterProvider() external {
        trustLayerEnabled[msg.sender] = false;
        emit ProviderDeregistered(msg.sender);
    }

    // ── Verification ─────────────────────────────────────────

    /**
     * @notice Called by ACP Job contracts during job evaluation.
     *
     * If the provider has TrustLayer enabled, the proof bundle in the
     * deliverable is verified on-chain. If verification passes, the
     * result is cached so the escrow can be released.
     *
     * If the provider does NOT have TrustLayer enabled, this is a no-op
     * and returns true (preserving backwards compatibility).
     *
     * @param jobId           ACP Job ID
     * @param providerAddress Provider's registered wallet
     * @param encodedBundle   ABI-encoded ProofBundle from the Deliverable Memo
     * @return verified       True if proof is valid or TrustLayer not enabled
     */
    function verifyDeliverable(
        uint256 jobId,
        address providerAddress,
        bytes calldata encodedBundle
    ) external returns (bool verified) {
        // If not opted in, pass through
        if (!trustLayerEnabled[providerAddress]) {
            return true;
        }

        // Decode the bundle
        ITrustLayer.ProofBundle memory bundle = abi.decode(
            encodedBundle,
            (ITrustLayer.ProofBundle)
        );

        // Verify via TrustLayerVerifier
        bool valid = verifier.verifyProofBundle(bundle, providerAddress);
        require(valid, "TrustLayerACPHook: proof bundle verification failed");

        // Cache the result
        verifiedBundles[providerAddress][bundle.chainHash] = true;

        emit DeliverableVerified(providerAddress, bundle.chainHash, jobId);
        return true;
    }

    /**
     * @notice Check if a provider's bundle has been verified.
     */
    function isProviderVerified(
        address provider,
        bytes32 chainHash
    ) external view returns (bool) {
        return verifiedBundles[provider][chainHash];
    }

    // ── Admin ────────────────────────────────────────────────

    function setVerifier(address newVerifier) external onlyOwner {
        verifier = ITrustLayer(newVerifier);
    }
}
