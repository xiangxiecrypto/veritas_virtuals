// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IPrimusZKTLS } from "./interfaces/IPrimusZKTLS.sol";
import { ITrustLayer } from "./interfaces/ITrustLayer.sol";
import { ProofParser } from "./libraries/ProofParser.sol";

/**
 * @title TrustLayerVerifier
 * @notice Optional on-chain verifier for TrustLayer proof bundles.
 *
 * Verifies that an ACP Provider:
 *  1. Actually fetched data from a trusted real-world HTTPS endpoint
 *  2. Fed that exact data (by hash) into a downstream HTTPS API
 *  3. The Deliverable Memo reflects the true downstream API output
 *
 * Proof generation happens off-chain through the Primus core-sdk package.
 * This contract is only responsible for optional on-chain verification of the
 * resulting attestation bundle.
 */
contract TrustLayerVerifier is ITrustLayer, Ownable {
    using ProofParser for string;
    using ProofParser for bytes32;

    // ── State ────────────────────────────────────────────────

    IPrimusZKTLS public immutable primus;

    /// @inheritdoc ITrustLayer
    uint256 public maxAttestationAge;

    /// domain keccak256 hash → trusted
    mapping(bytes32 => bool) private _trustedDomains;

    // ── Constructor ──────────────────────────────────────────

    constructor(
        address primusAddress,
        uint256 _maxAttestationAge
    ) Ownable(msg.sender) {
        primus = IPrimusZKTLS(primusAddress);
        maxAttestationAge = _maxAttestationAge;

        // Seed the trusted domain whitelist
        _addDomain("reuters.com");
        _addDomain("apnews.com");
        _addDomain("sec.gov");
        _addDomain("coindesk.com");
        _addDomain("cointelegraph.com");
        _addDomain("coingecko.com");
        _addDomain("api.coingecko.com");
        _addDomain("finance.yahoo.com");
        _addDomain("api.binance.com");
        _addDomain("api.coinbase.com");
        _addDomain("www.okx.com");
        _addDomain("api.openai.com");
        _addDomain("api.anthropic.com");
        _addDomain("api.mistral.ai");
        _addDomain("generativelanguage.googleapis.com");
        _addDomain("api.together.xyz");
        _addDomain("api.groq.com");
    }

    // ── Core Verification ────────────────────────────────────

    /// @inheritdoc ITrustLayer
    function verifyProofBundle(
        ProofBundle calldata bundle,
        address providerAddress
    ) external view override returns (bool) {
        require(bundle.steps.length > 0, "TrustLayer: empty proof bundle");
        require(
            bundle.providerWallet == providerAddress,
            "TrustLayer: provider wallet mismatch"
        );

        bytes32 rollingHash;

        for (uint256 i = 0; i < bundle.steps.length; i++) {
            ProofStep calldata step = bundle.steps[i];
            IPrimusZKTLS.Attestation calldata att = step.attestation;

        // ── Check 1: Primus attestation signature ──────────
            // Reverts internally if invalid
            primus.verifyAttestation(att);

            // ── Check 2: recipient == provider wallet ──────────
            require(
                att.attestation.recipient == providerAddress,
                "TrustLayer: recipient mismatch"
            );

            // ── Check 3: URL domain in whitelist ───────────────
            require(att.attestation.request.length > 0, "TrustLayer: empty request");
            string memory domain = ProofParser.extractDomain(
                att.attestation.request[0].url
            );
            require(
                _trustedDomains[keccak256(bytes(domain))],
                string(abi.encodePacked("TrustLayer: untrusted domain: ", domain))
            );

            // ── Check 4: timestamp within SLA window ───────────
            // attestation.timestamp is in milliseconds
            uint256 attestationAgeMs = block.timestamp * 1000 > att.attestation.timestamp
                ? block.timestamp * 1000 - att.attestation.timestamp
                : 0;
            require(
                attestationAgeMs <= maxAttestationAge * 1000,
                "TrustLayer: attestation too old"
            );

            // ── Check 5: chain linkage ─────────────────────────
            // Each step (after the first) must reference the previous
            // step's data hash inside its request body.
            if (i > 0) {
                string memory prevData = bundle.steps[i - 1].attestation.attestation.data;
                bytes32 prevDataHash = sha256(bytes(prevData));
                string memory reqBody = att.attestation.request[0].body;

                require(
                    ProofParser.containsHash(reqBody, prevDataHash),
                    string(abi.encodePacked(
                        "TrustLayer: chain linkage broken at step ", _toString(i)
                    ))
                );
            }

            // ── Accumulate chain hash ──────────────────────────
            rollingHash = keccak256(
                abi.encodePacked(rollingHash, att.taskId)
            );
        }

        // ── Check 6: bundle chain hash integrity ───────────────
        // The SDK computes the same rolling keccak256 chain hash off-chain.
        require(
            rollingHash == bundle.chainHash,
            "TrustLayer: chain hash mismatch"
        );

        return true;
    }

    // ── Domain Whitelist Management ──────────────────────────

    /// @inheritdoc ITrustLayer
    function isDomainTrusted(string calldata domain) external view override returns (bool) {
        return _isDomainTrusted(domain);
    }

    /// @inheritdoc ITrustLayer
    function addTrustedDomain(string calldata domain) external override onlyOwner {
        _addDomain(domain);
    }

    /// @inheritdoc ITrustLayer
    function removeTrustedDomain(string calldata domain) external override onlyOwner {
        bytes32 h = keccak256(bytes(domain));
        _trustedDomains[h] = false;
        emit DomainRemoved(h);
    }

    /// @notice Update max attestation age. Owner only.
    function setMaxAttestationAge(uint256 ageSecs) external onlyOwner {
        maxAttestationAge = ageSecs;
    }

    // ── Internal Helpers ─────────────────────────────────────

    function _addDomain(string memory domain) internal {
        bytes32 h = keccak256(bytes(domain));
        _trustedDomains[h] = true;
        emit DomainWhitelisted(h, domain);
    }

    function _isDomainTrusted(string memory domain) internal view returns (bool) {
        if (_trustedDomains[keccak256(bytes(domain))]) return true;
        // Subdomain fallback: "api.openai.com" → check "openai.com"
        bytes memory b = bytes(domain);
        for (uint i = 0; i < b.length; i++) {
            if (b[i] == ".") {
                string memory apex = _slice(domain, i + 1, b.length);
                if (_trustedDomains[keccak256(bytes(apex))]) return true;
                break;
            }
        }
        return false;
    }

    function _slice(
        string memory s,
        uint start,
        uint end
    ) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory result = new bytes(end - start);
        for (uint i = 0; i < end - start; i++) result[i] = b[start + i];
        return string(result);
    }

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
