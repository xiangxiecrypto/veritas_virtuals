/**
 * Domain utility functions.
 *
 * Off-chain domain checking is optional and purely a convenience.
 * The authoritative domain enforcement happens in each evaluator's
 * IEvaluatorPolicy contract on-chain (not in VeritasVerifier).
 *
 * Providers can pass a custom `trustedDomains` set to ProofChainBuilder
 * for early rejection of typos or misconfigurations. If omitted, no
 * off-chain domain check is performed.
 */

/**
 * Extract the hostname from a full URL.
 * "https://api.openai.com/v1/chat/completions" → "api.openai.com"
 */
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
}

/**
 * Check if a URL's domain is in a given whitelist.
 * Supports subdomain matching: "api.reuters.com" matches "reuters.com"
 *
 * If no whitelist is provided, returns true (allow all).
 */
export function isTrustedDomain(url: string, whitelist?: Set<string>): boolean {
  if (!whitelist || whitelist.size === 0) return true;
  const hostname = extractDomain(url);
  if (whitelist.has(hostname)) return true;
  const parts = hostname.split(".");
  if (parts.length > 2) {
    const apex = parts.slice(-2).join(".");
    if (whitelist.has(apex)) return true;
  }
  return false;
}

/**
 * Whether a URL is a known LLM inference endpoint.
 * Utility for SDK consumers — not enforced anywhere.
 */
export function isLLMEndpoint(url: string): boolean {
  const LLM_DOMAINS = new Set([
    "api.openai.com",
    "api.z.ai",
    "api.anthropic.com",
    "api.mistral.ai",
    "generativelanguage.googleapis.com",
    "api.together.xyz",
    "api.groq.com",
  ]);
  const hostname = extractDomain(url);
  return LLM_DOMAINS.has(hostname);
}
