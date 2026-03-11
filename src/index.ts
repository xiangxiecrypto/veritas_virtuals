// TrustLayer SDK — Public API
// ─────────────────────────────────────────────────────────────

// Core
export { ProofChainBuilder } from "./core/ProofChainBuilder.js";
export { StepProver } from "./core/StepProver.js";

// Chain
export { OnChainSubmitter, CONTRACT_ADDRESSES } from "./chain/OnChainSubmitter.js";
export type { Network, ContractAddressOverrides } from "./chain/OnChainSubmitter.js";

// Types
export type {
  StepConfig,
  StepResult,
  ProofBundle,
  ProofStep,
  ProofChainBuilderConfig,
  PrimusAttestationResult,
  PrimusAttestation,
  PrimusAttestor,
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
export { extractDomain, isTrustedDomain, isLLMEndpoint } from "./utils/domain.js";
