// ─────────────────────────────────────────────────────────────
//  TrustLayer — Core Types
// ─────────────────────────────────────────────────────────────

// ── Primus SDK types (mirrored from @primuslabs/zktls-core-sdk / attestation shape) ──

export interface PrimusRequest {
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  header: Record<string, string>;
  body: string;
}

export interface PrimusResponseResolve {
  keyName: string;
  parseType: "json" | "html" | "text";
  parsePath: string;
  // Optional: apply zkTLS operation instead of revealing raw value
  op?: "SHA256" | "SHA256_EX" | ">" | "<" | "=" | "!=" | ">=" | "<=";
  value?: string;
}

export interface PrimusAttestation {
  recipient: string;           // Provider wallet address
  request: PrimusRequest[];
  responseResolve: PrimusResponseResolve[][];
  data: string;                // JSON string of verified extracted data
  attConditions: string;       // JSON string of conditions
  timestamp: number;           // Unix ms
  additionParams: string;      // JSON string: { algorithmType }
}

export interface PrimusAttestationResult {
  attestation: PrimusAttestation;
  attestor: string;            // Attestation signer / verifier-side identifier
  signature: string;           // ECDSA signature over attestation
  reportTxHash: string;        // On-chain report tx
  taskId: string;              // Unique task identifier
  attestationTime: number;     // Time taken in ms
  attestorUrl: string;         // Verifier/attestation service URL
}

// ── TrustLayer Step Config ──────────────────────────────────

export type AttestationMode = "proxytls" | "mpctls";

export interface StepConfig {
  /** Unique identifier for this step within the proof chain */
  stepId: string;

  /** Target HTTPS endpoint */
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  headers: Record<string, string>;

  /**
   * Static body string, OR a builder function that receives
   * the results of previously completed steps.
   * The builder MUST embed the hash of a parent step's data
   * if dependsOn is set — TrustLayer enforces this.
   */
  body?: string;
  bodyBuilder?: (prevSteps: Record<string, StepResult>) => string;

  /** Which fields to extract and verify from the response */
  responseResolves: PrimusResponseResolve[];

  /**
   * zkTLS mode:
   *  - proxytls — lower latency, suitable for most HTTPS APIs (DEFAULT)
   *  - mpctls   — higher security, suitable for highly sensitive authenticated APIs
   */
  mode?: AttestationMode;

  /**
   * If set, TrustLayer will verify that this step's request body
   * contains SHA256(prevStep.data[sourceField]) before attesting.
   * This creates the cryptographic chain linkage.
   */
  dependsOn?: {
    stepId: string;
    sourceField: string;
  };
}

// ── Step Execution Result ───────────────────────────────────

export interface StepResult {
  stepId: string;
  /** Parsed data extracted by responseResolves */
  data: Record<string, string>;
  /** SHA256 of the full raw data string — used for chain linkage */
  dataHash: string;
  /** Full Primus attestation result */
  attestation: PrimusAttestationResult;
  /** When this step was executed */
  executedAt: number;
}

// ── Proof Bundle (submitted in ACP Deliverable Memo) ────────

export interface ProofStep {
  stepId: string;
  attestation: PrimusAttestationResult;
}

export interface ProofBundle {
  /** Protocol version for future upgrades */
  version: "1.0";
  /** Provider wallet address — must match attestation recipients */
  providerWallet: string;
  /** Ordered list of proven steps */
  steps: ProofStep[];
  /**
   * keccak256 of all taskIds concatenated — used on-chain
   * to verify the bundle hasn't been tampered with
   */
  chainHash: string;
  /** When the bundle was built */
  builtAt: number;
}

// ── Builder Config ──────────────────────────────────────────

export interface ProofChainBuilderConfig {
  primusAppId: string;
  primusAppSecret: string;
  /** Provider's wallet address — embedded in each attestation as recipient */
  providerWallet: string;
  /**
   * Optional trusted domain whitelist enforced off-chain before submitting
   * to Primus. If omitted, the SDK uses the built-in default whitelist.
   *
   * Note: the ultimate security boundary is still the on-chain whitelist
   * enforced by `TrustLayerVerifier.sol`.
   */
  trustedDomains?: Iterable<string>;
  /**
   * Maximum age of an attestation in ms.
   * Attestations older than this will be rejected by the on-chain verifier.
   * Default: 600_000 (10 minutes)
   */
  maxAttestationAge?: number;
}

// ── On-chain Submission ─────────────────────────────────────

export interface OnChainVerificationResult {
  verified: boolean;
  txHash?: string;
  error?: string;
}

// ── Errors ──────────────────────────────────────────────────

export class TrustLayerError extends Error {
  constructor(
    message: string,
    public readonly code: TrustLayerErrorCode,
    public readonly stepId?: string,
  ) {
    super(message);
    this.name = "TrustLayerError";
  }
}

export enum TrustLayerErrorCode {
  ATTESTATION_INVALID          = "ATTESTATION_INVALID",
  CHAIN_LINKAGE_BROKEN         = "CHAIN_LINKAGE_BROKEN",
  UNTRUSTED_DOMAIN             = "UNTRUSTED_DOMAIN",
  STEP_NOT_FOUND               = "STEP_NOT_FOUND",
  BODY_BUILDER_REQUIRED        = "BODY_BUILDER_REQUIRED",
  RECIPIENT_MISMATCH           = "RECIPIENT_MISMATCH",
  ATTESTATION_TOO_OLD          = "ATTESTATION_TOO_OLD",
  PRIMUS_INIT_FAILED           = "PRIMUS_INIT_FAILED",
}
