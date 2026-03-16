// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IACPHook
 * @notice ERC-8183 hook interface used by AgenticCommerce-style job escrows.
 *
 * The official reference repositories keep the historical `IACPHook` name,
 * even though the architecture is ERC-8183. Hooks receive before/after
 * callbacks for job lifecycle transitions and may revert to gate them.
 */
interface IACPHook {
    function beforeAction(
        uint256 jobId,
        bytes4 selector,
        bytes calldata data
    ) external;

    function afterAction(
        uint256 jobId,
        bytes4 selector,
        bytes calldata data
    ) external;
}
