// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ProofParser
 * @notice Helper library for parsing and validating proof data strings.
 */
library ProofParser {

    /**
     * @notice Extract the domain/hostname from a URL string.
     * "https://api.openai.com/v1/chat/completions" → "api.openai.com"
     */
    function extractDomain(string memory url) internal pure returns (string memory) {
        bytes memory b = bytes(url);
        // Find "://" and start after it
        uint start = 0;
        for (uint i = 0; i < b.length - 2; i++) {
            if (b[i] == ":" && b[i+1] == "/" && b[i+2] == "/") {
                start = i + 3;
                break;
            }
        }
        // Find the next "/" after the domain
        uint end = start;
        while (end < b.length && b[end] != "/") {
            end++;
        }
        bytes memory domain = new bytes(end - start);
        for (uint i = 0; i < end - start; i++) {
            domain[i] = b[start + i];
        }
        return string(domain);
    }

    /**
     * @notice Check if a string body contains a hex string representation
     *         of a bytes32 hash. Used to verify chain linkage.
     */
    function containsHash(
        string memory body,
        bytes32 targetHash
    ) internal pure returns (bool) {
        string memory hexHash = toHexString(targetHash);
        return includes(bytes(body), bytes(hexHash));
    }

    /**
     * @notice Convert bytes32 to lowercase hex string without "0x" prefix.
     */
    function toHexString(bytes32 value) internal pure returns (string memory) {
        bytes memory hexChars = "0123456789abcdef";
        bytes memory result = new bytes(64);
        for (uint i = 0; i < 32; i++) {
            result[i * 2]     = hexChars[uint8(value[i]) >> 4];
            result[i * 2 + 1] = hexChars[uint8(value[i]) & 0x0f];
        }
        return string(result);
    }

    /**
     * @notice Check if haystack contains needle.
     */
    function includes(bytes memory haystack, bytes memory needle) internal pure returns (bool) {
        if (needle.length == 0) return true;
        if (haystack.length < needle.length) return false;
        for (uint i = 0; i <= haystack.length - needle.length; i++) {
            bool found = true;
            for (uint j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    found = false;
                    break;
                }
            }
            if (found) return true;
        }
        return false;
    }
}
