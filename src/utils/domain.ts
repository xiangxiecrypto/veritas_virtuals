/**
 * Default trusted domain whitelist.
 * On-chain, this is enforced by TrustLayerVerifier.sol.
 * Off-chain, this is enforced by StepProver before submitting.
 */
export const TRUSTED_DOMAINS = new Set([
  // ── Data Sources ──────────────────────────────
  "reuters.com",
  "apnews.com",
  "sec.gov",
  "bloomberg.com",
  "coindesk.com",
  "cointelegraph.com",
  "coingecko.com",
  "api.coingecko.com",
  "finance.yahoo.com",
  "api.binance.com",
  "api.coinbase.com",
  "www.okx.com",
  // ── LLM APIs ─────────────────────────────────
  "api.openai.com",
  "api.deepseek.com",
  "api.anthropic.com",
  "api.mistral.ai",
  "generativelanguage.googleapis.com",
  "api.together.xyz",
  "api.groq.com",
]);

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
 * Check if a URL's domain is in the trusted whitelist.
 * Supports subdomain matching: "api.reuters.com" matches "reuters.com"
 */
export function isTrustedDomain(url: string, whitelist = TRUSTED_DOMAINS): boolean {
  const hostname = extractDomain(url);
  // Exact match
  if (whitelist.has(hostname)) return true;
  // Subdomain match: api.openai.com → openai.com
  const parts = hostname.split(".");
  if (parts.length > 2) {
    const apex = parts.slice(-2).join(".");
    if (whitelist.has(apex)) return true;
  }
  return false;
}

/**
 * Whether a URL is a known LLM inference endpoint.
 * Used to select mpctls mode automatically.
 */
export function isLLMEndpoint(url: string): boolean {
  const LLM_DOMAINS = new Set([
    "api.openai.com",
    "api.deepseek.com",
    "api.anthropic.com",
    "api.mistral.ai",
    "generativelanguage.googleapis.com",
    "api.together.xyz",
    "api.groq.com",
  ]);
  const hostname = extractDomain(url);
  return LLM_DOMAINS.has(hostname);
}
