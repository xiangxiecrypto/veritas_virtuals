// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IPrimusZKTLS, Attestation } from "./interfaces/IPrimusZKTLS.sol";
import { IVeritas } from "./interfaces/IVeritas.sol";
import { ProofParser } from "./libraries/ProofParser.sol";

/**
 * @title VeritasVerifier
 * @notice On-chain verifier for Veritas proof bundles.
 *
 * Responsible ONLY for cryptographic proof verification:
 *   1. Primus attestation signature is valid
 *   2. Attestation recipient matches the claimed provider wallet
 *   3. Attestation timestamp is within the freshness window
 *   4. Cross-step chain linkage is intact (SHA256 hash dependency)
 *   5. Bundle-level chain hash integrity
 *
 * Domain whitelists, step requirements, and other business-level rules
 * are NOT enforced here. Those belong in IEvaluatorPolicy contracts
 * deployed by individual evaluators and called by a protocol integration hook
 * such as VeritasERC8183Hook.
 *
 * The Attestation struct matches the official Primus zkTLS contract:
 * https://github.com/primus-labs/zktls-contracts/blob/main/src/IPrimusZKTLS.sol
 */
contract VeritasVerifier is IVeritas, Ownable {
    using ProofParser for string;
    using ProofParser for bytes32;

    // ── State ────────────────────────────────────────────────

    IPrimusZKTLS public immutable primus;

    /// @inheritdoc IVeritas
    uint256 public maxAttestationAge;

    // ── Constructor ──────────────────────────────────────────

    constructor(
        address primusAddress,
        uint256 _maxAttestationAge
    ) Ownable(msg.sender) {
        primus = IPrimusZKTLS(primusAddress);
        maxAttestationAge = _maxAttestationAge;
    }

    // ── Core Verification ────────────────────────────────────

    /// @inheritdoc IVeritas
    function verifyProofBundle(
        ProofBundle calldata bundle,
        address providerAddress
    ) external view override returns (bool) {
        require(bundle.steps.length > 0, "Veritas: empty proof bundle");
        require(
            bundle.providerWallet == providerAddress,
            "Veritas: provider wallet mismatch"
        );

        bytes32 rollingHash;

        for (uint256 i = 0; i < bundle.steps.length; i++) {
            ProofStep calldata step = bundle.steps[i];
            Attestation calldata att = step.attestation;

            // ── Check 1: Primus attestation signature ──────────
            primus.verifyAttestation(att);

            // ── Check 2: recipient == provider wallet ──────────
            require(
                att.recipient == providerAddress,
                "Veritas: recipient mismatch"
            );

            // ── Check 3: timestamp within SLA window ───────────
            require(
                bytes(att.request.url).length > 0,
                "Veritas: empty request URL"
            );
            uint256 attTimestamp = uint256(att.timestamp);
            uint256 attestationAgeMs = block.timestamp * 1000 > attTimestamp
                ? block.timestamp * 1000 - attTimestamp
                : 0;
            require(
                attestationAgeMs <= maxAttestationAge * 1000,
                "Veritas: attestation too old"
            );

            // ── Check 4: chain linkage ─────────────────────────
            if (i > 0) {
                string memory prevData = bundle.steps[i - 1].attestation.data;
                bytes32 prevDataHash = sha256(bytes(prevData));
                string memory reqBody = att.request.body;

                require(
                    ProofParser.containsHash(reqBody, prevDataHash),
                    string(abi.encodePacked(
                        "Veritas: chain linkage broken at step ", _toString(i)
                    ))
                );
            }

            // ── Accumulate chain hash ──────────────────────────
            rollingHash = keccak256(
                abi.encodePacked(rollingHash, step.primusTaskId)
            );
        }

        // ── Check 5: bundle chain hash integrity ───────────────
        require(
            rollingHash == bundle.chainHash,
            "Veritas: chain hash mismatch"
        );

        return true;
    }

    // ── Admin ────────────────────────────────────────────────

    /// @notice Update max attestation age. Owner only.
    function setMaxAttestationAge(uint256 ageSecs) external onlyOwner {
        maxAttestationAge = ageSecs;
    }

    // ── Internal Helpers ─────────────────────────────────────

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
