// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ITrustLayer } from "./interfaces/ITrustLayer.sol";
import { IEvaluatorPolicy } from "./interfaces/IEvaluatorPolicy.sol";

/**
 * @title TrustLayerACPHook
 * @notice Integration hook between TrustLayer and the Virtuals ACP Job system.
 *
 * Two roles interact with this contract:
 *
 *   Provider  — opts in to TrustLayer via `registerProvider()`.
 *   Evaluator — registers the address of their IEvaluatorPolicy contract
 *               via `setPolicy()`. The policy contract can contain any
 *               custom Solidity logic.
 *
 * Once a policy is set, verification is **fully automated**:
 *
 *   1. ACP Job contract calls `verifyDeliverable(jobId, provider, evaluator, bundle)`
 *   2. Hook delegates proof-authenticity check to TrustLayerVerifier
 *   3. Hook calls the evaluator's policy contract via IEvaluatorPolicy.check()
 *   4. If both pass, the result is cached and escrow can release
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │  ACP Job Contract                                       │
 * │  onEvaluate:                                            │
 * │    ACPHook.verifyDeliverable(job, provider, eval, data) │
 * │    if verified → escrow.release()                       │
 * └─────────────────────────────────────────────────────────┘
 */
contract TrustLayerACPHook is Ownable {

    // ── State ────────────────────────────────────────────────

    ITrustLayer public verifier;

    /// Providers who have opted into TrustLayer verification
    mapping(address => bool) public trustLayerEnabled;

    /// evaluator address → their IEvaluatorPolicy contract
    mapping(address => IEvaluatorPolicy) public evaluatorPolicies;

    /// provider → chainHash → verified
    mapping(address => mapping(bytes32 => bool)) public verifiedBundles;

    // ── Events ───────────────────────────────────────────────

    event ProviderRegistered(address indexed provider);
    event ProviderDeregistered(address indexed provider);

    event PolicySet(address indexed evaluator, address indexed policyContract);
    event PolicyRemoved(address indexed evaluator);

    event DeliverableVerified(
        address indexed provider,
        address indexed evaluator,
        bytes32 indexed chainHash,
        uint256 jobId
    );

    // ── Constructor ──────────────────────────────────────────

    constructor(address verifierAddress) Ownable(msg.sender) {
        verifier = ITrustLayer(verifierAddress);
    }

    // ── Provider Registration ────────────────────────────────

    function registerProvider() external {
        trustLayerEnabled[msg.sender] = true;
        emit ProviderRegistered(msg.sender);
    }

    function deregisterProvider() external {
        trustLayerEnabled[msg.sender] = false;
        emit ProviderDeregistered(msg.sender);
    }

    // ── Evaluator Policy Management ──────────────────────────

    /**
     * @notice Set (or update) the evaluator's policy contract.
     *
     * The policy contract must implement IEvaluatorPolicy.
     * Deploy your custom policy once, then register its address here.
     * After this, verifyDeliverable enforces it automatically.
     *
     * @param policyContract Address of the deployed IEvaluatorPolicy contract
     */
    function setPolicy(address policyContract) external {
        require(policyContract != address(0), "TrustLayerACPHook: zero address");
        evaluatorPolicies[msg.sender] = IEvaluatorPolicy(policyContract);
        emit PolicySet(msg.sender, policyContract);
    }

    /**
     * @notice Remove the evaluator's policy. Verification will only
     *         check proof authenticity (no business-level checks).
     */
    function removePolicy() external {
        delete evaluatorPolicies[msg.sender];
        emit PolicyRemoved(msg.sender);
    }

    // ── Automated Verification ───────────────────────────────

    /**
     * @notice Called by ACP Job contracts during job evaluation.
     *
     * Verification flow (fully automated, zero human intervention):
     *   1. If provider has not opted in, pass through (backward compatible)
     *   2. Verify proof authenticity via TrustLayerVerifier
     *   3. If evaluator has a policy contract, call IEvaluatorPolicy.check()
     *   4. Cache the result so escrow can release
     *
     * @param jobId              ACP Job ID
     * @param providerAddress    Provider's registered wallet
     * @param evaluatorAddress   Evaluator whose policy to apply
     * @param encodedBundle      ABI-encoded ProofBundle from the Deliverable Memo
     * @return verified          True if proof is valid and policy is satisfied
     */
    function verifyDeliverable(
        uint256 jobId,
        address providerAddress,
        address evaluatorAddress,
        bytes calldata encodedBundle
    ) external returns (bool verified) {
        if (!trustLayerEnabled[providerAddress]) {
            return true;
        }

        ITrustLayer.ProofBundle memory bundle = abi.decode(
            encodedBundle,
            (ITrustLayer.ProofBundle)
        );

        // ── Step 1: proof authenticity ───────────────────────
        bool valid = verifier.verifyProofBundle(bundle, providerAddress);
        require(valid, "TrustLayerACPHook: proof verification failed");

        // ── Step 2: evaluator policy ─────────────────────────
        IEvaluatorPolicy policy = evaluatorPolicies[evaluatorAddress];
        if (address(policy) != address(0)) {
            bool passed = policy.check(bundle, providerAddress);
            require(passed, "TrustLayerACPHook: evaluator policy rejected");
        }

        // ── Step 3: cache result ─────────────────────────────
        verifiedBundles[providerAddress][bundle.chainHash] = true;

        emit DeliverableVerified(
            providerAddress,
            evaluatorAddress,
            bundle.chainHash,
            jobId
        );
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
