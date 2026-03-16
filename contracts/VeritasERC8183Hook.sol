// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ERC165 } from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import { IVeritas } from "./interfaces/IVeritas.sol";
import { IEvaluatorPolicy } from "./interfaces/IEvaluatorPolicy.sol";
import { IACPHook } from "./interfaces/IACPHook.sol";
import { IAgenticCommerce } from "./interfaces/IAgenticCommerce.sol";

/**
 * @title VeritasERC8183Hook
 * @notice ERC-8183 hook that verifies Veritas proof bundles during `submit`.
 *
 * Flow:
 *   1. Provider submits ERC-8183 job with `deliverable == bundle.chainHash`
 *   2. `optParams` contains the ABI-encoded Veritas ProofBundle
 *   3. Hook verifies bundle authenticity via VeritasVerifier
 *   4. Hook enforces the evaluator's IEvaluatorPolicy
 *   5. Hook caches the verified job/bundle so evaluator can complete safely
 *
 * This keeps Veritas protocol-agnostic at the core, while integrating
 * directly with the ERC-8183 hook architecture instead of ACP-specific flows.
 */
contract VeritasERC8183Hook is Ownable, ERC165, IACPHook {
    IVeritas public verifier;
    IAgenticCommerce public immutable agenticCommerce;

    /// evaluator => custom policy contract
    mapping(address => IEvaluatorPolicy) public evaluatorPolicies;

    /// provider => chainHash => verified
    mapping(address => mapping(bytes32 => bool)) public verifiedBundles;

    /// jobId => verified bundle chain hash
    mapping(uint256 => bytes32) public verifiedJobBundles;

    /// jobId => submitted deliverable hash
    mapping(uint256 => bytes32) public submittedDeliverables;

    bytes4 private constant SEL_SUBMIT =
        bytes4(keccak256("submit(uint256,bytes32,bytes)"));
    bytes4 private constant SEL_COMPLETE =
        bytes4(keccak256("complete(uint256,bytes32,bytes)"));

    event PolicySet(address indexed evaluator, address indexed policyContract);
    event PolicyRemoved(address indexed evaluator);
    event JobBundleVerified(
        uint256 indexed jobId,
        address indexed provider,
        address indexed evaluator,
        bytes32 chainHash,
        bytes32 deliverable
    );

    error OnlyAgenticCommerce();

    constructor(
        address verifierAddress,
        address agenticCommerceAddress
    ) Ownable(msg.sender) {
        verifier = IVeritas(verifierAddress);
        agenticCommerce = IAgenticCommerce(agenticCommerceAddress);
    }

    modifier onlyAgenticCommerceContract() {
        if (msg.sender != address(agenticCommerce)) revert OnlyAgenticCommerce();
        _;
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view virtual override returns (bool) {
        return
            interfaceId == type(IACPHook).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    function setPolicy(address policyContract) external {
        require(
            policyContract != address(0),
            "VeritasERC8183Hook: zero address"
        );
        evaluatorPolicies[msg.sender] = IEvaluatorPolicy(policyContract);
        emit PolicySet(msg.sender, policyContract);
    }

    function removePolicy() external {
        delete evaluatorPolicies[msg.sender];
        emit PolicyRemoved(msg.sender);
    }

    function beforeAction(
        uint256 jobId,
        bytes4 selector,
        bytes calldata data
    ) external view override onlyAgenticCommerceContract {
        if (selector == SEL_SUBMIT) {
            _preSubmit(jobId, data);
        } else if (selector == SEL_COMPLETE) {
            _preComplete(jobId);
        }
    }

    function afterAction(
        uint256 jobId,
        bytes4 selector,
        bytes calldata data
    ) external override onlyAgenticCommerceContract {
        if (selector == SEL_SUBMIT) {
            _postSubmit(jobId, data);
        }
    }

    function validateJobSubmission(
        uint256 jobId,
        bytes calldata encodedBundle
    ) external view returns (bool) {
        IAgenticCommerce.Job memory job = agenticCommerce.getJob(jobId);
        IVeritas.ProofBundle memory bundle = abi.decode(
            encodedBundle,
            (IVeritas.ProofBundle)
        );
        _validateBundle(job, bundle);
        return true;
    }

    function isProviderVerified(
        address provider,
        bytes32 chainHash
    ) external view returns (bool) {
        return verifiedBundles[provider][chainHash];
    }

    function isJobVerified(uint256 jobId) external view returns (bool) {
        return verifiedJobBundles[jobId] != bytes32(0);
    }

    function setVerifier(address newVerifier) external onlyOwner {
        verifier = IVeritas(newVerifier);
    }

    function _preSubmit(uint256 jobId, bytes calldata data) internal view {
        (
            address caller,
            bytes32 deliverable,
            bytes memory optParams
        ) = abi.decode(data, (address, bytes32, bytes));

        IAgenticCommerce.Job memory job = agenticCommerce.getJob(jobId);
        require(job.id != 0, "VeritasERC8183Hook: invalid job");
        require(
            caller == job.provider,
            "VeritasERC8183Hook: caller is not provider"
        );

        IVeritas.ProofBundle memory bundle = abi.decode(
            optParams,
            (IVeritas.ProofBundle)
        );
        require(
            deliverable == bundle.chainHash,
            "VeritasERC8183Hook: deliverable must equal bundle chainHash"
        );

        _validateBundle(job, bundle);
    }

    function _postSubmit(uint256 jobId, bytes calldata data) internal {
        (, bytes32 deliverable, bytes memory optParams) = abi.decode(
            data,
            (address, bytes32, bytes)
        );
        IAgenticCommerce.Job memory job = agenticCommerce.getJob(jobId);
        IVeritas.ProofBundle memory bundle = abi.decode(
            optParams,
            (IVeritas.ProofBundle)
        );

        verifiedBundles[job.provider][bundle.chainHash] = true;
        verifiedJobBundles[jobId] = bundle.chainHash;
        submittedDeliverables[jobId] = deliverable;

        emit JobBundleVerified(
            jobId,
            job.provider,
            job.evaluator,
            bundle.chainHash,
            deliverable
        );
    }

    function _preComplete(uint256 jobId) internal view {
        require(
            verifiedJobBundles[jobId] != bytes32(0),
            "VeritasERC8183Hook: job not yet Veritas-verified"
        );
        require(
            submittedDeliverables[jobId] == verifiedJobBundles[jobId],
            "VeritasERC8183Hook: submitted deliverable mismatch"
        );
    }

    function _validateBundle(
        IAgenticCommerce.Job memory job,
        IVeritas.ProofBundle memory bundle
    ) internal view {
        require(
            bundle.providerWallet == job.provider,
            "VeritasERC8183Hook: provider wallet mismatch"
        );

        bool valid = verifier.verifyProofBundle(bundle, job.provider);
        require(valid, "VeritasERC8183Hook: proof verification failed");

        IEvaluatorPolicy policy = evaluatorPolicies[job.evaluator];
        if (address(policy) != address(0)) {
            bool passed = policy.check(bundle, job.provider);
            require(
                passed,
                "VeritasERC8183Hook: evaluator policy rejected"
            );
        }
    }
}
