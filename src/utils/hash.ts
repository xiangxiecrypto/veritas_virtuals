import crypto from "crypto";

/**
 * SHA-256 hash of a string, returned as a hex string.
 * Used to create chain linkage between proof steps.
 */
export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Compute the chain hash for a ProofBundle.
 * This is a rolling keccak-style hash over all taskIds in order.
 * Matches the on-chain computation in TrustLayerVerifier.sol.
 */
export function computeChainHash(taskIds: string[]): string {
  let rolling = "";
  for (const id of taskIds) {
    rolling = sha256(rolling + id);
  }
  return rolling;
}

/**
 * Verify that a string body contains the SHA-256 hash of a given value.
 * This confirms the chain linkage: the LLM prompt contains the hash
 * of the data source response.
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
