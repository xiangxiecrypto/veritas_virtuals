// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IAgenticCommerce
 * @notice Minimal ERC-8183 core interface required by Veritas hooks/scripts.
 */
interface IAgenticCommerce {
    enum JobStatus {
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    struct Job {
        uint256 id;
        address client;
        address provider;
        address evaluator;
        string description;
        uint256 budget;
        uint256 expiredAt;
        JobStatus status;
        address hook;
    }

    function getJob(uint256 jobId) external view returns (Job memory);

    function submit(
        uint256 jobId,
        bytes32 deliverable,
        bytes calldata optParams
    ) external;

    function complete(
        uint256 jobId,
        bytes32 reason,
        bytes calldata optParams
    ) external;
}
