// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IPrimusZKTLS
 * @notice Interface for the Primus zkTLS on-chain attestation verifier.
 *
 * Matches the official contract at:
 * https://github.com/primus-labs/zktls-contracts/blob/main/src/IPrimusZKTLS.sol
 *
 * Proof generation happens off-chain through the Primus core-sdk package.
 * This contract is only used when a caller wants to verify the resulting
 * attestation on-chain as an additional guarantee.
 */

struct Attestation {
    address recipient;
    AttNetworkRequest request;
    AttNetworkResponseResolve[] reponseResolve;
    string data;
    string attConditions;
    uint64 timestamp;
    string additionParams;
    Attestor[] attestors;
    bytes[] signatures;
}

struct AttNetworkRequest {
    string url;
    string header;
    string method;
    string body;
}

struct AttNetworkResponseResolve {
    string keyName;
    string parseType;
    string parsePath;
}

struct Attestor {
    address attestorAddr;
    string url;
}

interface IPrimusZKTLS {
    function verifyAttestation(Attestation calldata attestation) external view;
}
