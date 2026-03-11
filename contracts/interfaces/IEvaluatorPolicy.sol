// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ITrustLayer } from "./ITrustLayer.sol";

/**
 * @title IEvaluatorPolicy
 * @notice Interface that every evaluator policy contract must implement.
 *
 * Each evaluator deploys their own contract with arbitrary verification logic.
 * The TrustLayerACPHook calls `check()` after proof authenticity has been
 * confirmed by the TrustLayerVerifier. If `check()` reverts or returns false,
 * the deliverable is rejected.
 *
 * This gives evaluators full freedom to define any on-chain conditions:
 *   - Required step IDs / domains / response fields
 *   - Cross-step data relationships
 *   - Custom scoring thresholds
 *   - Time-based or context-dependent rules
 *
 * Example:
 *
 *   contract FactCheckPolicy is IEvaluatorPolicy {
 *       function check(
 *           ITrustLayer.ProofBundle calldata bundle,
 *           address provider
 *       ) external view returns (bool) {
 *           require(bundle.steps.length >= 2, "need 2 steps");
 *           // ... any custom logic ...
 *           return true;
 *       }
 *   }
 */
interface IEvaluatorPolicy {
    /**
     * @notice Evaluate whether a proof bundle satisfies this policy.
     *
     * Called by TrustLayerACPHook AFTER TrustLayerVerifier has already
     * confirmed proof authenticity. The policy only needs to check
     * business-level requirements.
     *
     * @param bundle    The decoded ProofBundle
     * @param provider  The provider's wallet address
     * @return passed   True if the bundle satisfies this evaluator's policy
     */
    function check(
        ITrustLayer.ProofBundle calldata bundle,
        address provider
    ) external view returns (bool passed);
}
