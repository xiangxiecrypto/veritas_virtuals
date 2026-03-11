// TrustLayer SDK — Public API
// ─────────────────────────────────────────────────────────────

// Core
export { ProofChainBuilder } from "./core/ProofChainBuilder.js";
export { StepProver } from "./core/StepProver.js";

// Chain
export { OnChainSubmitter, CONTRACT_ADDRESSES } from "./chain/OnChainSubmitter.js";
export type { Network } from "./chain/OnChainSubmitter.js";

// Types
export type {
  StepConfig,
  StepResult,
  ProofBundle,
  ProofStep,
  ProofChainBuilderConfig,
  PrimusAttestationResult,
  PrimusAttestation,
  PrimusRequest,
  PrimusResponseResolve,
  AttestationMode,
  OnChainVerificationResult,
} from "./types/index.js";

export {
  TrustLayerError,
  TrustLayerErrorCode,
} from "./types/index.js";

// Utils (useful for bodyBuilder implementations)
export { sha256, buildHashReference, bodyContainsHash } from "./utils/hash.js";
export { isTrustedDomain, isLLMEndpoint, TRUSTED_DOMAINS } from "./utils/domain.js";
