// ─────────────────────────────────────────────────────────────
//  TrustLayer — Core Types
// ─────────────────────────────────────────────────────────────

// ── Primus SDK types ──
//
// These mirror the on-chain struct layout from the official Primus contract:
// https://github.com/primus-labs/zktls-contracts/blob/main/src/IPrimusZKTLS.sol
//
// The on-chain Attestation struct includes attestors[] and signatures[].
// The SDK returns attestor/signature at the outer level of the result,
// so we split into PrimusAttestation (inner) and PrimusAttestationResult (outer).

export interface PrimusRequest {
  url: string;
  header: string;   // JSON string of request headers
  method: string;
  body: string;
}

export interface PrimusResponseResolve {
  keyName: string;
  parseType: string;
  parsePath: string;
  op?: string;
  value?: string;
}

export interface PrimusAttestor {
  attestorAddr: string;
  url: string;
}

/**
 * Core attestation body as returned by the Primus core-sdk.
 *
 * On-chain, this maps to the inner fields of the Attestation struct
 * (without attestors[] / signatures[] which live at the outer level
 * in the on-chain struct and at the outer PrimusAttestationResult in the SDK).
 */
export interface PrimusAttestation {
  recipient: string;
  request: PrimusRequest;
  responseResolve: PrimusResponseResolve[];
  data: string;
  attConditions: string;
  timestamp: number;        // uint64 on-chain, Unix ms
  additionParams: string;
}

/**
 * Full SDK-level attestation result returned by PrimusCoreTLS.startAttestation().
 *
 * For on-chain submission, OnChainSubmitter assembles these fields into
 * the official Attestation struct (with attestors[] and signatures[]).
 */
export interface PrimusAttestationResult {
  attestation: PrimusAttestation;
  attestor: string;            // Attestor address (goes into attestors[0].attestorAddr)
  signature: string;           // ECDSA signature (goes into signatures[0])
  reportTxHash: string;
  taskId: string;              // Primus SDK task identifier, not part of the on-chain Attestation struct
  attestationTime: number;     // Duration in ms
  attestorUrl: string;         // Attestor service URL (goes into attestors[0].url)
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
   * contains SHA256(prevStep.attestation.data) before attesting.
   * This creates the cryptographic chain linkage that can also be checked
   * by the on-chain verifier. `sourceField` is still useful for validating
   * the application-level dependency and for building the downstream request.
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
  /**
   * Primus SDK task identifier copied out of `PrimusAttestationResult.taskId`.
   * Kept at the TrustLayer step level to avoid implying it belongs to the
   * official Primus on-chain Attestation struct.
   */
  primusTaskId: string;
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
   * keccak256 of all `primusTaskId` values concatenated — used on-chain
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
