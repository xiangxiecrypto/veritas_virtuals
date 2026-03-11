// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ITrustLayer } from "../interfaces/ITrustLayer.sol";
import { IEvaluatorPolicy } from "../interfaces/IEvaluatorPolicy.sol";
import { ProofParser } from "../libraries/ProofParser.sol";

/**
 * @title FactCheckPolicy
 * @notice Example evaluator policy: requires a 2-step fact-check pipeline
 *         (data_source → llm_inference) with domain whitelist and freshness.
 *
 * Demonstrates how domain restrictions, step requirements, and timestamp
 * checks are implemented at the evaluator policy level (not the verifier).
 *
 * Deploy this contract, then call `hook.setPolicy(address)` to activate.
 * After that, all verifyDeliverable calls for this evaluator are fully automated.
 *
 * Evaluators can deploy their own contract with any custom logic
 * as long as it implements IEvaluatorPolicy.
 */
contract FactCheckPolicy is IEvaluatorPolicy {

    bytes32 private constant STEP_DATA_SOURCE    = keccak256("data_source");
    bytes32 private constant STEP_LLM_INFERENCE  = keccak256("llm_inference");

    uint256 public immutable maxAgeSecs;

    /// Domain whitelist: keccak256(domain) → trusted
    mapping(bytes32 => bool) public trustedDomains;

    address public immutable admin;

    constructor(uint256 _maxAgeSecs, string[] memory _trustedDomains) {
        maxAgeSecs = _maxAgeSecs;
        admin = msg.sender;
        for (uint256 i = 0; i < _trustedDomains.length; i++) {
            trustedDomains[keccak256(bytes(_trustedDomains[i]))] = true;
        }
    }

    /// @notice Evaluator admin can add domains after deployment
    function addDomain(string calldata domain) external {
        require(msg.sender == admin, "FactCheckPolicy: not admin");
        trustedDomains[keccak256(bytes(domain))] = true;
    }

    /// @notice Evaluator admin can remove domains
    function removeDomain(string calldata domain) external {
        require(msg.sender == admin, "FactCheckPolicy: not admin");
        trustedDomains[keccak256(bytes(domain))] = false;
    }

    function check(
        ITrustLayer.ProofBundle calldata bundle,
        address /* provider */
    ) external view override returns (bool) {
        require(bundle.steps.length >= 2, "FactCheckPolicy: need >= 2 steps");

        bool hasDataSource;
        bool hasLLM;

        uint256 maxAgeMs = maxAgeSecs * 1000;
        uint256 nowMs = block.timestamp * 1000;

        for (uint256 i = 0; i < bundle.steps.length; i++) {
            bytes32 idHash = keccak256(bytes(bundle.steps[i].stepId));

            if (idHash == STEP_DATA_SOURCE)   hasDataSource = true;
            if (idHash == STEP_LLM_INFERENCE) hasLLM = true;

            // Domain check: each step's URL must be from a trusted domain
            string memory domain = ProofParser.extractDomain(
                bundle.steps[i].attestation.request.url
            );
            require(
                trustedDomains[keccak256(bytes(domain))],
                "FactCheckPolicy: untrusted domain"
            );

            // Freshness check
            uint256 attTs = uint256(bundle.steps[i].attestation.timestamp);
            uint256 ageMs = nowMs > attTs ? nowMs - attTs : 0;
            require(ageMs <= maxAgeMs, "FactCheckPolicy: attestation too old");
        }

        require(hasDataSource, "FactCheckPolicy: missing data_source step");
        require(hasLLM,        "FactCheckPolicy: missing llm_inference step");

        return true;
    }
}
