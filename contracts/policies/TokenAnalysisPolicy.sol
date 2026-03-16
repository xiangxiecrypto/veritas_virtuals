// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IVeritas } from "../interfaces/IVeritas.sol";
import { IEvaluatorPolicy } from "../interfaces/IEvaluatorPolicy.sol";
import { ProofParser } from "../libraries/ProofParser.sol";

/**
 * @title TokenAnalysisPolicy
 * @notice Reference evaluator policy for token analysis providers.
 *         Requires:
 *         - at least 2 steps
 *         - `data_source` and `llm_inference`
 *         - trusted domains
 *         - fresh attestations
 *
 * Deploy this contract, then call `hook.setPolicy(address)` for the
 * evaluator address that should enforce it inside the ERC-8183 hook flow.
 */
contract TokenAnalysisPolicy is IEvaluatorPolicy {

    bytes32 private constant STEP_DATA_SOURCE   = keccak256("data_source");
    bytes32 private constant STEP_LLM_INFERENCE = keccak256("llm_inference");

    uint256 public immutable maxAgeSecs;
    mapping(bytes32 => bool) public trustedDomains;
    address public immutable admin;

    constructor(uint256 _maxAgeSecs, string[] memory _trustedDomains) {
        maxAgeSecs = _maxAgeSecs;
        admin = msg.sender;

        for (uint256 i = 0; i < _trustedDomains.length; i++) {
            trustedDomains[keccak256(bytes(_trustedDomains[i]))] = true;
        }
    }

    function addDomain(string calldata domain) external {
        require(msg.sender == admin, "TokenAnalysisPolicy: not admin");
        trustedDomains[keccak256(bytes(domain))] = true;
    }

    function removeDomain(string calldata domain) external {
        require(msg.sender == admin, "TokenAnalysisPolicy: not admin");
        trustedDomains[keccak256(bytes(domain))] = false;
    }

    function check(
        IVeritas.ProofBundle calldata bundle,
        address /* provider */
    ) external view override returns (bool) {
        require(bundle.steps.length >= 2, "TokenAnalysisPolicy: need >= 2 steps");

        bool hasDataSource;
        bool hasLLM;

        uint256 maxAgeMs = maxAgeSecs * 1000;
        uint256 nowMs = block.timestamp * 1000;

        for (uint256 i = 0; i < bundle.steps.length; i++) {
            bytes32 idHash = keccak256(bytes(bundle.steps[i].stepId));
            if (idHash == STEP_DATA_SOURCE) hasDataSource = true;
            if (idHash == STEP_LLM_INFERENCE) hasLLM = true;

            string memory domain = ProofParser.extractDomain(
                bundle.steps[i].attestation.request.url
            );
            require(
                trustedDomains[keccak256(bytes(domain))],
                "TokenAnalysisPolicy: untrusted domain"
            );

            uint256 attTs = uint256(bundle.steps[i].attestation.timestamp);
            uint256 ageMs = nowMs > attTs ? nowMs - attTs : 0;
            require(ageMs <= maxAgeMs, "TokenAnalysisPolicy: attestation too old");
        }

        require(hasDataSource, "TokenAnalysisPolicy: missing data_source step");
        require(hasLLM, "TokenAnalysisPolicy: missing llm_inference step");

        return true;
    }
}
