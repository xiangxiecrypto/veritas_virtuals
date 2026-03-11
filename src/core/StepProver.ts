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
 *  1. Validate the target URL against the trusted domain whitelist
 *  2. Enforce chain linkage: if dependsOn is set, verify the body
 *     contains SHA256(parentStep.data[sourceField])
 *  3. Execute the Primus zkTLS attestation
 *  4. Validate the returned attestation signature
 *  5. Return a StepResult with parsed data and dataHash
 */
export class StepProver {
  // PrimusNetwork instance is injected — typed as any because
  // @primuslabs/network-core-sdk ships CommonJS without .d.ts
  constructor(private readonly primusNetwork: any) {}

  async prove(
    config: StepConfig,
    prevSteps: Record<string, StepResult>,
    providerWallet: string,
  ): Promise<StepResult> {
    // ── 1. Domain whitelist check ───────────────────────────
    if (!isTrustedDomain(config.url)) {
      throw new TrustLayerError(
        `Domain not in trusted whitelist: ${config.url}`,
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

      if (!bodyContainsHash(body, parentFieldValue)) {
        throw new TrustLayerError(
          `Chain linkage broken: body does not contain SHA256(${parentId}.${sourceField}). ` +
          `Use buildHashReference() to embed the hash in your bodyBuilder.`,
          TrustLayerErrorCode.CHAIN_LINKAGE_BROKEN,
          config.stepId,
        );
      }
    }

    // ── 4. Build Primus request params ──────────────────────
    const requests = [
      {
        url: config.url,
        method: config.method,
        header: config.headers,
        body,
      },
    ];

    const responseResolves = [config.responseResolves];

    // ── 5. Submit task to Primus network ────────────────────
    let submitTaskResult: any;
    try {
      submitTaskResult = await this.primusNetwork.submitTask(requests);
    } catch (err: any) {
      throw new TrustLayerError(
        `Primus submitTask failed: ${err.message}`,
        TrustLayerErrorCode.PRIMUS_INIT_FAILED,
        config.stepId,
      );
    }

    // ── 6. Execute attestation ──────────────────────────────
    const attestParams = {
      ...submitTaskResult,
      requests,
      responseResolves,
      additionParams: JSON.stringify({ algorithmType: config.mode }),
    };

    const attestResults: PrimusAttestationResult[] =
      await this.primusNetwork.attest(attestParams);

    const attestResult = attestResults[0];

    // ── 7. Validate attestation signature ───────────────────
    const isValid = this.primusNetwork.verifyAttestation(attestResult);
    if (!isValid) {
      throw new TrustLayerError(
        `Attestation signature invalid for step: ${config.stepId}`,
        TrustLayerErrorCode.ATTESTATION_INVALID,
        config.stepId,
      );
    }

    // ── 8. Validate recipient matches provider wallet ────────
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

    // ── 9. Parse extracted data ──────────────────────────────
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
