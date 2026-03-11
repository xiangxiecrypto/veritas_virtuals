import crypto from "crypto";
import { ethers } from "ethers";

/**
 * SHA-256 hash of a string, returned as a hex string.
 * Used to create chain linkage between proof steps.
 */
export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Compute the chain hash for a ProofBundle.
 * This matches the on-chain computation in `TrustLayerVerifier.sol`:
 * `rollingHash = keccak256(abi.encodePacked(rollingHash, step.primusTaskId))`.
 *
 * The return value is a bytes32 hex string with `0x` prefix.
 */
export function computeChainHash(primusTaskIds: string[]): string {
  let rolling: string = ethers.ZeroHash; // bytes32(0)
  for (const primusTaskId of primusTaskIds) {
    rolling = ethers.solidityPackedKeccak256(
      ["bytes32", "string"],
      [rolling, primusTaskId],
    );
  }
  return rolling;
}

/**
 * Verify that a string body contains the SHA-256 hash of a given value.
 * This confirms the chain linkage: a downstream request body contains the hash
 * of the upstream attestation data (or whichever payload the caller chooses
 * to anchor with `buildHashReference()`).
 */
export function bodyContainsHash(body: string, value: string): boolean {
  const hash = sha256(value);
  return body.includes(hash);
}

/**
 * Build the expected chain-linkage comment to embed in a prompt or body.
 * Example: "[source_hash:abc123...]"
 */
export function buildHashReference(stepId: string, value: string): string {
  return `[source_hash:${stepId}:${sha256(value)}]`;
}
