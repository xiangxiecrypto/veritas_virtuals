// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IPrimusZKTLS
 * @notice Interface for the Primus zkTLS on-chain verifier.
 * Deployed on Base mainnet at: 0xCE7cefB3B5A7eB44B59F60327A53c9Ce53B0afdE
 */
interface IPrimusZKTLS {
    struct AttestationRequest {
        string url;
        string header;
        string method;
        string body;
    }

    struct ResponseResolveItem {
        string keyName;
        string parseType;
        string parsePath;
    }

    struct ResponseResolve {
        ResponseResolveItem[] oneUrlResponseResolve;
    }

    struct AttestationCore {
        address recipient;
        AttestationRequest[] request;
        ResponseResolve[] responseResolve;
        string data;
        string attConditions;
        uint256 timestamp;
        string additionParams;
    }

    struct Attestation {
        AttestationCore attestation;
        address attestor;
        string signature;
        string reportTxHash;
        string taskId;
        uint256 attestationTime;
        string attestorUrl;
    }

    /**
     * @notice Verify a zkTLS attestation produced by a Primus TEE node.
     * Reverts if the attestation is invalid.
     * @param attestation The full attestation struct
     */
    function verifyAttestation(Attestation calldata attestation) external view;
}
