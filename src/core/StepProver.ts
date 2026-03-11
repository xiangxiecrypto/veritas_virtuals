import {
  StepConfig,
  StepResult,
  PrimusAttestationResult,
  TrustLayerError,
  TrustLayerErrorCode,
} from "../types/index.js";
import { sha256, bodyContainsHash } from "../utils/hash.js";
import { isTrustedDomain } from "../utils/domain.js";

/**
 * StepProver handles the execution of a single proof step.
 *
 * Responsibilities:
 *  1. Optional off-chain domain check (if trustedDomains provided)
 *  2. Enforce chain linkage: if dependsOn is set, verify the body
 *     contains SHA256(parentStep.data[sourceField])
 *  3. Execute the Primus core-sdk attestation flow off-chain
 *  4. Validate the returned attestation signature off-chain with the SDK
 *  5. Return a StepResult with parsed data and dataHash
 */
export class StepProver {
  private readonly trustedDomains?: Set<string>;

  constructor(
    private readonly primusCore: any,
    opts?: { trustedDomains?: Iterable<string> },
  ) {
    this.trustedDomains = opts?.trustedDomains
      ? new Set(opts.trustedDomains)
      : undefined;
  }

  async prove(
    config: StepConfig,
    prevSteps: Record<string, StepResult>,
    providerWallet: string,
  ): Promise<StepResult> {
    const mode = config.mode ?? "proxytls";
    // ── 1. Optional off-chain domain check ──────────────────
    // Only enforced when the caller passes a trustedDomains set.
    // If omitted, all domains are allowed at the SDK level.
    // On-chain domain enforcement belongs in IEvaluatorPolicy contracts.
    if (!isTrustedDomain(config.url, this.trustedDomains)) {
      throw new TrustLayerError(
        `Domain not in configured trustedDomains: ${config.url}`,
        TrustLayerErrorCode.UNTRUSTED_DOMAIN,
        config.stepId,
      );
    }

    // ── 2. Build request body ───────────────────────────────
    let body = "";
    if (config.bodyBuilder) {
      body = config.bodyBuilder(prevSteps);
    } else if (config.body) {
      body = config.body;
    }

    // ── 3. Enforce chain linkage ────────────────────────────
    if (config.dependsOn) {
      const { stepId: parentId, sourceField } = config.dependsOn;
      const parent = prevSteps[parentId];

      if (!parent) {
        throw new TrustLayerError(
          `dependsOn step "${parentId}" has not been proven yet`,
          TrustLayerErrorCode.STEP_NOT_FOUND,
          config.stepId,
        );
      }

      const parentFieldValue = parent.data[sourceField];
      if (!parentFieldValue) {
        throw new TrustLayerError(
          `Field "${sourceField}" not found in parent step "${parentId}" data`,
          TrustLayerErrorCode.STEP_NOT_FOUND,
          config.stepId,
        );
      }

      const parentRawData = parent.attestation.attestation.data;
      if (!bodyContainsHash(body, parentRawData)) {
        throw new TrustLayerError(
          `Chain linkage broken: body does not contain SHA256(${parentId}.attestation.data). ` +
          `Use buildHashReference() with the parent step's raw attestation data.`,
          TrustLayerErrorCode.CHAIN_LINKAGE_BROKEN,
          config.stepId,
        );
      }
    }

    // ── 4. Execute Primus Core SDK attestation off-chain ─────
    // Core-SDK flow:
    //   generateRequestParams(request, responseResolves)
    //   setAttMode({ algorithmType })
    //   startAttestation(generateRequest)
    const request = {
      url: config.url,
      method: config.method,
      header: config.headers,
      body,
    };

    // Core-SDK example uses { keyName, parsePath }.
    // We keep compatibility with our richer type by mapping through.
    const responseResolves = config.responseResolves.map((r) => ({
      keyName: r.keyName,
      parsePath: r.parsePath,
      parseType: r.parseType,
      op: r.op,
      value: r.value,
    }));

    let generateRequest: any;
    try {
      generateRequest = this.primusCore.generateRequestParams(request, responseResolves);
    } catch (err: any) {
      throw new TrustLayerError(
        `Primus generateRequestParams failed: ${err?.message ?? String(err)}`,
        TrustLayerErrorCode.PRIMUS_INIT_FAILED,
        config.stepId,
      );
    }

    try {
      generateRequest.setAttMode({ algorithmType: mode });
    } catch {
      // Some SDK versions may not require explicit mode set here.
    }

    let attestResult: PrimusAttestationResult;
    try {
      attestResult = await this.primusCore.startAttestation(generateRequest);
    } catch (err: any) {
      throw new TrustLayerError(
        `Primus startAttestation failed: ${err?.message ?? String(err)}`,
        TrustLayerErrorCode.PRIMUS_INIT_FAILED,
        config.stepId,
      );
    }

    // ── 5. Validate attestation signature off-chain ─────────
    const isValid = this.primusCore.verifyAttestation(attestResult);
    if (!isValid) {
      throw new TrustLayerError(
        `Attestation signature invalid for step: ${config.stepId}`,
        TrustLayerErrorCode.ATTESTATION_INVALID,
        config.stepId,
      );
    }

    // ── 6. Validate recipient matches provider wallet ────────
    if (
      attestResult.attestation.recipient.toLowerCase() !==
      providerWallet.toLowerCase()
    ) {
      throw new TrustLayerError(
        `Attestation recipient ${attestResult.attestation.recipient} does not match provider wallet ${providerWallet}`,
        TrustLayerErrorCode.RECIPIENT_MISMATCH,
        config.stepId,
      );
    }

    // ── 7. Parse extracted data ──────────────────────────────
    let parsedData: Record<string, string> = {};
    try {
      parsedData = JSON.parse(attestResult.attestation.data);
    } catch {
      // data may be a plain string for some response types
      parsedData = { raw: attestResult.attestation.data };
    }

    const dataHash = sha256(attestResult.attestation.data);

    return {
      stepId: config.stepId,
      data: parsedData,
      dataHash,
      attestation: attestResult,
      executedAt: Date.now(),
    };
  }
}
